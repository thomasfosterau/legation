/**
 * Mirror.mutationStates (#116): the host's keyed mutation-state map, mirrored
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
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  SyncServer,
  Mirror,
} from "@thomasfosterau/legation-effect/internal";
import type { MutationState } from "@thomasfosterau/legation-effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Effect, HashMap, Option, Ref, Schema, Stream } from "effect";

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
type Todo = typeof TodoArgs.Type;

const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Poll until `read` passes `until`, with a bounded number of attempts. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
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
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
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

describe("EngineHost ↔ Mirror.mutationStates (#116)", () => {
  it.effect("a mirror sees the host's mutation states, pending then acknowledged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        const latest = yield* track(mirror.mutationStates);
        yield* mirror.mutate("todo/set", { id: "1", title: "from the tab", done: false });

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
          const { engine } = yield* makeEngine;
          const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: host, engine });

          const first = yield* Mirror.make({ channel: mirrorChannel, mutators });
          const firstLatest = yield* track(first.mutationStates);
          yield* first.mutate("todo/set", { id: "1", title: "before", done: false });
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
