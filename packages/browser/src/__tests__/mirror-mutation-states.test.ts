/**
 * Mirror.mutationStates: the host's keyed mutation-state map, mirrored
 * to tabs over the loopback channel — "tabs see the same states the host
 * holds." Mirror updates arrive on background fibers, so assertions poll with
 * real timers (clock-independent under the test environment).
 */
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@thomasfosterau/legation";
import {
  ClientEngine,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  SyncServer,
  Mirror,
  Protocol,
} from "@thomasfosterau/legation/internal";
import type { MutationState } from "@thomasfosterau/legation/internal";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestFailure } from "./test-failure.js";

const decodeIdentified = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  isDone: Schema.Boolean,
});
const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  {
    mutator: todoSet,
    local: (args, writer) =>
      writer.put("todos", Protocol.RowId.make(decodeIdentified(args).id), args),
  },
]);

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis);
    return Effect.sync(() => clearTimeout(timer));
  });

/** Poll until `read` passes `until`, with a bounded number of attempts. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) => {
  const attempt = (n: number): Effect.Effect<A> =>
    n === 200
      ? Effect.die(new TestFailure({ message: "eventually: condition never held" }))
      : Effect.filterOrElse(read, until, () => Effect.andThen(sleepReal(5), attempt(n + 1)));
  return attempt(0);
};

const makeEngine = Effect.fn("makeEngine")(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) =>
        writer.put("todos", Protocol.RowId.make(args.id), args)
      ),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, Protocol.ClientGroupId.make("group-a"));
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: Protocol.ClientGroupId.make("group-a"),
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return { engine, store };
});

/** Fork a background consumer of `mirror.mutationStates` into a pollable `Ref`. */
const track = (stream: Stream.Stream<MutationState.MutationStateMap>) =>
  Effect.gen(function* () {
    const latest = yield* Ref.make<MutationState.MutationStateMap>(HashMap.empty());
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (states) => Ref.set(latest, states)).pipe(Effect.ignore)
    );
    return latest;
  });

const get = (map: MutationState.MutationStateMap, id: number) =>
  Option.getOrUndefined(HashMap.get(map, id));

describe("EngineHost ↔ Mirror.mutationStates", () => {
  it.effect("a mirror sees the host's mutation states, pending then acknowledged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine();
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        const latest = yield* track(mirror.mutationStates);
        yield* mirror.mutate("todo/set", { id: "1", title: "from the tab", isDone: false });

        const pending = yield* eventually(Ref.get(latest), (states) => HashMap.size(states) === 1);
        expect(get(pending, 1)?.phase).toBe("pending");
        expect(get(pending, 1)?.mutator).toBe("todo/set");

        yield* engine.push;
        yield* eventually(Ref.get(latest), (states) => get(states, 1)?.phase === "acknowledged");
      })
    )
  );

  it.effect(
    "a second mirror hydrates from the host's already-active mutation-state registration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine } = yield* makeEngine();
          const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: host, engine });

          const first = yield* Mirror.make({ channel: mirrorChannel, mutators });
          const firstLatest = yield* track(first.mutationStates);
          yield* first.mutate("todo/set", { id: "1", title: "before", isDone: false });
          yield* eventually(Ref.get(firstLatest), (states) => HashMap.size(states) === 1);

          // A late-joining mirror on the same channel hydrates from the
          // host's current map — the same states the host holds.
          const second = yield* Mirror.make({ channel: mirrorChannel, mutators });
          const secondLatest = yield* track(second.mutationStates);
          const hydrated = yield* eventually(
            Ref.get(secondLatest),
            (states) => HashMap.size(states) === 1
          );
          expect(get(hydrated, 1)?.mutator).toBe("todo/set");
          expect(get(hydrated, 1)?.phase).toBe("pending");
        })
      )
  );
});
