/**
 * The enhanced form submit over a connected host (#536): a Client joined to an
 * engine host over a `MirrorChannel` asks the host to begin the form mutation,
 * and settles or abandons it on the receipt. The host holds the engine's
 * in-flight entry, so the optimistic effect is released by the pull that
 * covers the form client, not by the action's response, exactly as on an
 * engine (`form-mutation.test.ts`). A host that predates the begin answers it
 * with a clear failure rather than leaving the mirror waiting.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import * as Client from "../Client.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import type * as ClientView from "../ClientView.js";
import * as EngineHost from "../EngineHost.js";
import { MutationRejected, VersionNotSupportedError } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import * as Server from "../Server.js";
import * as Subscriptions from "../Subscriptions.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const counterArgs = Schema.Struct({ id: Schema.String });
// A non-idempotent counter: a double application shows as `n: 2`.
const increment = Mutator.make("counter/inc", counterArgs);
// The backend refuses it; the client's local handler still applies it.
const refuse = Mutator.make("counter/refuse", counterArgs);

const Counter = Schema.Struct({ id: Schema.String, n: Schema.Number });
const asCounter = Schema.decodeUnknownOption(Counter);
const incremented = (id: string, current: Option.Option<typeof Counter.Type>) => ({
  id,
  n: Option.match(current, { onNone: () => 0, onSome: (row) => row.n }) + 1,
});

const mutators = Mutator.registry([
  {
    mutator: increment,
    local: (args, writer) =>
      writer
        .get("counters", args.id)
        .pipe(
          Effect.flatMap((row) =>
            writer.put("counters", args.id, incremented(args.id, asCounter(row)))
          )
        ),
  },
  {
    mutator: refuse,
    local: (args, writer) => writer.put("counters", args.id, incremented(args.id, Option.none())),
  },
]);

const nodes = Node.registry([Node.make("counters", { attributes: { n: Schema.Number } })]);
const countersSubset = Subset.make({ collection: "counters" });
const form = { clientId: "form-1", mutationId: 1 } as const;

const makeServer = Effect.fn("makeServer")(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(increment, (args, writer) =>
        writer
          .get("counters", args.id)
          .pipe(
            Effect.flatMap((row) =>
              writer.put("counters", args.id, incremented(args.id, asCounter(row)))
            )
          )
      ),
      MemoryBackend.handler(refuse, () =>
        Effect.fail(new MutationRejected({ reason: "counter is locked" }))
      ),
    ])
  );
  return yield* Server.make({
    backend,
    auth: { policy: Authorization.policy({ counters: Authorization.allowAll }) },
  });
});

// The host's engine, whose pulls are refused while `refusing` is set (a
// version rejection, which the engine does not retry), so a test decides when
// the covering pull happens. A Client connects to it over a loopback channel.
const makeHosted = (server: Server.Server, refusing: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const inner = yield* makeInMemory(server.handler, "group-a");
    const transport: ClientTransport = {
      ...inner,
      pull: (request) =>
        Ref.get(refusing).pipe(
          Effect.flatMap((on) =>
            on
              ? Effect.fail(new VersionNotSupportedError({ message: "pulls refused by the test" }))
              : inner.pull(request)
          )
        ),
    };
    // One counted voice, as a real host has (ElectedHost): a mirror releasing
    // the window never drops the one this test pins.
    const engine = Subscriptions.counted(
      yield* ClientEngineModule.make({
        clientId: "host-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      )
    );
    yield* engine.subscribe(countersSubset);
    const pair = yield* MirrorChannel.makeLoopbackPair;
    yield* EngineHost.run({ channel: pair.host, engine, nodes });
    return { engine, store, channel: pair.mirror };
  });

const valuesOf = (rows: ReadonlyArray<ClientEngineModule.LocalRow>) => rows.map((row) => row.value);

/** The values of the first emission of `rows` that holds `count` rows (empty if the stream ends). */
const eventually = <E>(
  rows: Stream.Stream<ReadonlyArray<ClientEngineModule.LocalRow>, E>,
  count: number
) =>
  rows.pipe(
    Stream.filter((current) => current.length === count),
    Stream.runHead,
    Effect.map((head) => Option.match(head, { onNone: () => [], onSome: valuesOf }))
  );

const mirrorRows = (view: ClientView.ClientView, count: number) =>
  eventually(view.observe(countersSubset), count);

describe("enhanced form submit over a connected host (#536)", () => {
  it.effect("is dropped on the covering pull, not on the action's response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store, channel } = yield* makeHosted(server, refusing);
        const client = yield* Client.connect({ nodes, mutations: mutators, channel });

        // The host overlays the effect for every mirror and journals nothing.
        const submission = yield* client.beginFormMutation(form, increment.name, { id: "c1" });
        expect(yield* mirrorRows(client.view, 1)).toEqual([{ id: "c1", n: 1 }]);
        expect(yield* store.pendingMutations).toEqual([]);

        const receipt = yield* server.mutate({
          clientGroupId: "group-a",
          ...form,
          mutation: increment,
          args: { id: "c1" },
        });
        expect(receipt).toEqual({ ...form, phase: "acknowledged" });

        // Settling waits for the host: the entry is parked in its unpulled
        // tail, still overlaid.
        yield* submission.settle(receipt);
        expect((yield* store.unpulled).map((m) => [m.clientId, m.mutationId])).toEqual([
          ["form-1", 1],
        ]);
        expect(valuesOf(yield* engine.query(countersSubset))).toEqual([{ id: "c1", n: 1 }]);

        // The covering pull releases it: applied once, never twice.
        yield* Ref.set(refusing, false);
        yield* engine.pull;
        expect(yield* store.unpulled).toEqual([]);
        expect(valuesOf(yield* store.listRows("counters"))).toEqual([{ id: "c1", n: 1 }]);
        expect(yield* mirrorRows(client.view, 1)).toEqual([{ id: "c1", n: 1 }]);
      })
    )
  );

  it.effect("a rejected receipt drops the effect; a second settle does nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store, channel } = yield* makeHosted(server, refusing);
        const client = yield* Client.connect({ nodes, mutations: mutators, channel });

        const submission = yield* client.beginFormMutation(form, refuse.name, { id: "c2" });
        expect(yield* mirrorRows(client.view, 1)).toEqual([{ id: "c2", n: 1 }]);
        yield* submission.settle({ phase: "rejected", reason: "counter is locked" });
        expect(valuesOf(yield* engine.query(countersSubset))).toEqual([]);
        expect(yield* mirrorRows(client.view, 0)).toEqual([]);

        yield* submission.settle({ phase: "acknowledged" });
        expect(yield* store.unpulled).toEqual([]);
      })
    )
  );

  it.effect("a departing mirror abandons the entries it still held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, channel } = yield* makeHosted(server, refusing);

        const mirrorScope = yield* Scope.make();
        const client = yield* Client.connect({ nodes, mutations: mutators, channel }).pipe(
          Scope.provide(mirrorScope)
        );
        yield* client.beginFormMutation(form, increment.name, { id: "c3" });
        expect(valuesOf(yield* engine.query(countersSubset))).toEqual([{ id: "c3", n: 1 }]);

        // Closing the mirror's scope sends `Disconnect`; the host abandons the entry.
        yield* Scope.close(mirrorScope, Exit.void);
        expect(yield* eventually(engine.observe(countersSubset), 0)).toEqual([]);
      })
    )
  );

  it.effect("args that do not fit the Mutation fail in the mirror before anything is sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, channel } = yield* makeHosted(server, refusing);
        const client = yield* Client.connect({ nodes, mutations: mutators, channel });
        const error = yield* Effect.flip(client.beginFormMutation(form, increment.name, { id: 7 }));
        expect(error._tag).toBe("MutatorError");
        expect(valuesOf(yield* engine.query(countersSubset))).toEqual([]);
      })
    )
  );

  it.effect("a host that predates it answers with a clear failure, not a hang", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* MirrorChannel.makeLoopbackPair;
        // A host from before #536: it decodes the begin as an ordinary `Mutate`
        // and its engine has no such mutator, so it answers `MutateError`.
        const inbox = yield* pair.host.subscribe;
        yield* Effect.forkScoped(
          Effect.forever(
            inbox.take.pipe(
              Effect.flatMap(MirrorProtocol.decodeMirrorMessage),
              Effect.flatMap((message) =>
                message?._tag === "Mutate"
                  ? pair.host.post({
                      _tag: "MutateError",
                      requestId: message.requestId,
                      message: `Unknown mutator: ${message.mutator}`,
                    })
                  : Effect.void
              )
            )
          )
        );
        const client = yield* Client.connect({ nodes, mutations: mutators, channel: pair.mirror });
        const error = yield* Effect.flip(
          client.beginFormMutation(form, increment.name, { id: "c4" })
        );
        expect(error._tag).toBe("TransportError");
        expect(error.message).toMatch(/predates enhanced form submits/);
      })
    )
  );
});
