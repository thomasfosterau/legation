/**
 * Two tabs on one host (#546): every host reply reaches every mirror on the
 * channel, and each mirror numbers its requests from zero. With both tabs'
 * request 1 in flight, each must still get its own `mutate`, `mutateWithAck`
 * and `read` answer, never the other tab's. A reply carries the requesting
 * mirror's id; one without (from a host that predates it) is still taken by
 * its `requestId`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngine from "../ClientEngine.js";
import * as ClientStore from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import { MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mirror from "../Mirror.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Transport from "../Transport.js";

const Note = Schema.Struct({ id: Schema.String });

const put = Mutator.make("note/put", Note);
const refused = Mutator.make("note/refused", Note);
// Known to the second tab's registry, not to the host's engine.
const unknownToHost = Mutator.make("note/unknown", Note);

const writes = <Name extends string>(
  mutator: Mutator.Mutator<Name, typeof Note.Type, typeof Note.Encoded>
) => ({
  mutator,
  local: (args: typeof Note.Type, writer: Mutator.LocalWriter) =>
    writer.put("notes", args.id, args),
});

const mutators = Mutator.registry([writes(put), writes(refused)]);
const widerMutators = Mutator.registry([writes(put), writes(refused), writes(unknownToHost)]);

const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(put, (args, writer) => Effect.asVoid(writer.put("notes", args.id, args))),
  MemoryBackend.handler(refused, () => Effect.fail(new MutationRejected({ reason: "refused" }))),
]);

const only = (id: string) => Subset.make({ collection: "notes", where: Predicate.eq("id", id) });

const decodeMessage = Schema.decodeUnknownOption(MirrorProtocol.MirrorMessageSchema);

type MutateMessage = Extract<MirrorProtocol.MirrorMessage, { readonly _tag: "Mutate" }>;
const isMutate = (message: MirrorProtocol.MirrorMessage): message is MutateMessage =>
  P.isTagged(message, "Mutate");

const makeHost = Effect.fn("makeHost")(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ notes: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "host-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
  yield* EngineHost.run({ channel: host, engine });
  const tabA = yield* Mirror.make({ channel, mutators });
  const tabB = yield* Mirror.make({ channel, mutators: widerMutators });
  return { engine, store, tabA, tabB };
});

/** A scripted host: answers each `Mutate` the mirrors post with `answer`. */
const scriptedHost = (
  host: MirrorChannel.MirrorChannel,
  answer: (message: MutateMessage) => Effect.Effect<void, unknown>
) =>
  Effect.gen(function* () {
    const inbox = yield* host.subscribe;
    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap((raw) =>
            Option.match(Option.filter(decodeMessage(raw), isMutate), {
              onNone: () => Effect.void,
              onSome: (message) => Effect.ignore(answer(message)),
            })
          )
        )
      )
    );
  });

const both = <A, B, E1, E2>(a: Effect.Effect<A, E1>, b: Effect.Effect<B, E2>) =>
  Effect.all([Effect.exit(a), Effect.exit(b)], { concurrency: "unbounded" });

describe("mirror replies are addressed to the requesting mirror (#546)", () => {
  it.effect("each tab's mutate gets its own answer", () =>
    Effect.gen(function* () {
      const { tabA, tabB } = yield* makeHost();
      const [a, b] = yield* both(
        tabA.mutate(put.name, { id: "a1" }),
        tabB.mutate(unknownToHost.name, { id: "b1" })
      );
      expect(Exit.isSuccess(a)).toBe(true);
      expect(Exit.match(b, { onSuccess: () => "", onFailure: String })).toMatch(
        /Unknown mutator: note\/unknown/
      );
    })
  );

  it.effect("each tab's mutateWithAck reports its own backend outcome", () =>
    Effect.gen(function* () {
      const { engine, store, tabA, tabB } = yield* makeHost();
      const a = yield* Effect.forkChild(tabA.mutateWithAck(put.name, { id: "a1" }));
      const b = yield* Effect.forkChild(tabB.mutateWithAck(refused.name, { id: "b1" }));
      yield* store.pendingMutations.pipe(
        Effect.repeat({ until: (pending) => pending.length === 2 })
      );
      yield* engine.push;
      expect(yield* Fiber.join(a)).toEqual({ _tag: "applied" });
      expect(yield* Fiber.join(b)).toEqual({ _tag: "rejected", reason: "refused" });
    })
  );

  it.effect("each tab's read gets its own rows", () =>
    Effect.gen(function* () {
      const { engine, store, tabA, tabB } = yield* makeHost();
      yield* engine.mutate(put.name, { id: "a1" });
      yield* engine.mutate(put.name, { id: "b1" });
      yield* engine.push;
      expect((yield* store.pendingMutations).length).toBe(0);
      const [a, b] = yield* both(tabA.read([only("a1")]), tabB.read([only("b1")]));
      const ids = (exit: typeof a) =>
        Exit.match(exit, {
          onSuccess: (rows) => rows.map((row) => row.id),
          onFailure: (cause) => [String(cause)],
        });
      expect(ids(a)).toEqual(["a1"]);
      expect(ids(b)).toEqual(["b1"]);
    })
  );

  it.effect("takes a reply that names no mirror, as a host that predates the field sends", () =>
    Effect.gen(function* () {
      const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      yield* scriptedHost(host, (message) =>
        host.post({ _tag: "MutateAck", requestId: message.requestId })
      );
      const tab = yield* Mirror.make({ channel, mutators });
      yield* tab.mutate(put.name, { id: "a1" });
    })
  );

  it.effect("ignores a reply addressed to another mirror", () =>
    Effect.gen(function* () {
      const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      // It first fails the request as if for another tab, then acks it for this one.
      yield* scriptedHost(host, (message) =>
        host
          .post({
            _tag: "MutateError",
            requestId: message.requestId,
            mirrorId: "another-tab",
            message: "not yours",
          })
          .pipe(
            Effect.andThen(
              host.post({
                _tag: "MutateAck",
                requestId: message.requestId,
                mirrorId: message.mirrorId,
              })
            )
          )
      );
      const tab = yield* Mirror.make({ channel, mutators });
      yield* tab.mutate(put.name, { id: "a1" });
    })
  );
});
