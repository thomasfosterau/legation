/**
 * Tab-side backend outcomes (#36): `TabMirror.mutateWithAck` resolves with the
 * mutation's authoritative outcome (applied or permanently rejected), forwarded
 * from the host over the mirror. Wiring mirrors `tab-mirror.test.ts`; the
 * rejecting backend mirrors the engine's `poison-mutations.test.ts`.
 */
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  EngineHost,
  InvalidationBus,
  MemoryBackend,
  MirrorChannel,
  MutationRejected,
  Mutator,
  SyncServer,
  TabMirror,
  Transport,
} from "@legation/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
  {
    mutator: Mutator.make("todo/forbidden", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/forbidden": (args, writer) =>
    writer
      .put("todos", (args as Todo).id, args)
      .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "permission revoked" })))),
};

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A, E>(read: Effect.Effect<A, E>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
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

describe("TabMirror.mutateWithAck (#36)", () => {
  it.effect("resolves applied once the host forwards the backend outcome", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tab, mutators });

      // The call blocks on the backend outcome, so run it on a fibre and drive
      // the push once the host has journaled it.
      const outcome = yield* Effect.forkChild(
        mirror.mutateWithAck("todo/set", { id: "1", title: "kept", done: false })
      );
      yield* eventually(store.pendingMutations, (pending) => pending.length === 1);
      yield* engine.push;

      expect(yield* Fiber.join(outcome)).toEqual({ _tag: "applied" });
    })
  );

  it.effect("resolves rejected with the backend reason", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tab, mutators });

      const outcome = yield* Effect.forkChild(
        mirror.mutateWithAck("todo/forbidden", { id: "x", title: "doomed", done: false })
      );
      yield* eventually(store.pendingMutations, (pending) => pending.length === 1);
      yield* engine.push;

      expect(yield* Fiber.join(outcome)).toEqual({
        _tag: "rejected",
        reason: "permission revoked",
      });
    })
  );
});
