/**
 * The client half of an enhanced form submit (ADR-0030 #215 §4). The engine
 * overlays the Mutation under the form client's id without journaling it, the
 * form action runs it on the server (`Server.mutate`), and the receipt moves
 * the entry to the unpulled tail. The optimistic effect is released by the
 * pull whose `lastMutationIds` covers the form client, **not** by the action's
 * response (#215's criterion).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import { MutationRejected, VersionNotSupportedError } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Server from "../Server.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const counterArgs = Schema.Struct({ id: Schema.String });
// A non-idempotent counter: a double application shows as `n: 2`.
const increment = Mutator.make("counter/inc", counterArgs);
// The backend refuses it; the client's local handler still applies it.
const refuse = Mutator.make("counter/refuse", counterArgs);

const Counter = Schema.Struct({ id: Schema.String, n: Schema.Number });
const asCounter = Schema.decodeUnknownOption(Counter);
// The counter after one more increment, from the row a writer read.
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

const countersSubset = Subset.make({ collection: "counters" });

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

// The engine of "client-a" in "group-a". Its pulls are refused while
// `refusing` is set (a version rejection, which the engine does not retry), so
// a test decides when the covering pull happens.
const makeEngine = (server: Server.Server, refusing: Ref.Ref<boolean>, unpulledLimit = 1024) =>
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
    const engine = yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators,
      unpulledLimit,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    yield* engine.subscribe(countersSubset);
    return { engine, store };
  });

const countsOf = (engine: ClientEngineModule.ClientEngine) =>
  engine.query(countersSubset).pipe(Effect.map((rows) => rows.map((row) => row.value)));

const form = { clientId: "form-1", mutationId: 1 } as const;

describe("enhanced form submit (ADR-0030 #215 §4)", () => {
  it.effect("is dropped on acknowledgement (the covering pull), not on the action's response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store } = yield* makeEngine(server, refusing);

        // The enhanced submit overlays the effect, and journals nothing.
        const submission = yield* engine.beginFormMutation(form, increment.name, { id: "c1" });
        expect(yield* countsOf(engine)).toEqual([{ id: "c1", n: 1 }]);
        expect(yield* store.pendingMutations).toEqual([]);

        // The form action runs it on the server and answers the receipt.
        const receipt = yield* server.mutate({
          clientGroupId: "group-a",
          ...form,
          mutation: increment,
          args: { id: "c1" },
        });
        expect(receipt).toEqual({ ...form, phase: "acknowledged" });

        // On the receipt the entry moves to the unpulled tail: still overlaid.
        yield* submission.settle(receipt);
        expect(yield* countsOf(engine)).toEqual([{ id: "c1", n: 1 }]);
        expect((yield* store.unpulled).map((m) => [m.clientId, m.mutationId])).toEqual([
          ["form-1", 1],
        ]);

        // The pull that covers the form client reveals the confirmed row and
        // releases the entry: applied once, never twice.
        yield* Ref.set(refusing, false);
        yield* engine.pull;
        expect(yield* store.unpulled).toEqual([]);
        expect(yield* countsOf(engine)).toEqual([{ id: "c1", n: 1 }]);
        const confirmed = yield* store.listRows("counters");
        expect(confirmed.map((row) => row.value)).toEqual([{ id: "c1", n: 1 }]);
      })
    )
  );

  it.effect("a rejected receipt drops the optimistic effect at once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store } = yield* makeEngine(server, refusing);

        const submission = yield* engine.beginFormMutation(form, refuse.name, { id: "c2" });
        expect(yield* countsOf(engine)).toEqual([{ id: "c2", n: 1 }]);
        const receipt = yield* server.mutate({
          clientGroupId: "group-a",
          ...form,
          mutation: refuse,
          args: { id: "c2" },
        });
        expect(receipt).toEqual({ ...form, phase: "rejected", reason: "counter is locked" });

        yield* submission.settle(receipt);
        expect(yield* countsOf(engine)).toEqual([]);
        expect(yield* store.unpulled).toEqual([]);
      })
    )
  );

  it.effect("an abandoned submission drops its effect; a second settle does nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store } = yield* makeEngine(server, refusing);

        const submission = yield* engine.beginFormMutation(form, increment.name, { id: "c3" });
        yield* submission.abandon;
        expect(yield* countsOf(engine)).toEqual([]);
        yield* submission.settle({ phase: "acknowledged" });
        expect(yield* store.unpulled).toEqual([]);
        expect(yield* countsOf(engine)).toEqual([]);
      })
    )
  );

  it.effect("with no room in the tail an acknowledgement drops the entry, keeping the bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine, store } = yield* makeEngine(server, refusing, 1);

        // A pushed mutation fills the one-entry tail while pulls are refused.
        yield* engine.mutate(increment.name, { id: "c4" });
        yield* engine.push.pipe(Effect.ignore);
        expect(yield* store.unpulled).toHaveLength(1);

        const submission = yield* engine.beginFormMutation(form, increment.name, { id: "c5" });
        expect(yield* countsOf(engine)).toContainEqual({ id: "c5", n: 1 });
        yield* submission.settle({ phase: "acknowledged" });
        expect(yield* store.unpulled).toHaveLength(1);
        expect(yield* countsOf(engine)).toEqual([{ id: "c4", n: 1 }]);
      })
    )
  );

  it.effect("args that do not fit the Mutation's schema fail before anything is overlaid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer();
        const refusing = yield* Ref.make(true);
        const { engine } = yield* makeEngine(server, refusing);
        const error = yield* Effect.flip(engine.beginFormMutation(form, increment.name, { id: 7 }));
        expect(error._tag).toBe("MutatorError");
        expect(yield* countsOf(engine)).toEqual([]);
      })
    )
  );
});
