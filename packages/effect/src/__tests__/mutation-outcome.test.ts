/**
 * Per-mutation outcome surface (#36): `mutateWithAck` returns a handle whose
 * `acknowledged` effect resolves with the mutation's authoritative outcome
 * (applied or permanently rejected), `mutationEvents` reports the lifecycle,
 * pending acknowledgements are interrupted on scope close, and plain `mutate`
 * is unchanged. The rejecting backend is copied from `poison-mutations.test.ts`.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

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

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const allTodos = Subset.make({ collection: "todos" });

const makeEngine = (handler: ServerHandler, store: ClientStore) =>
  makeInMemory(handler, "group-a").pipe(
    Effect.flatMap((transport) =>
      ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      )
    )
  );

describe("per-mutation outcome (#36)", () => {
  it.effect("acknowledged resolves applied after push for a good mutation", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const handle = yield* engine.mutateWithAck("todo/set", {
        id: "y",
        title: "kept",
        done: false,
      });
      // The push acknowledges the id, settling the outcome as applied.
      yield* engine.push;
      const outcome = yield* handle.acknowledged;
      expect(outcome).toEqual({ _tag: "applied" });
    })
  );

  it.effect("acknowledged resolves rejected with the backend reason", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const handle = yield* engine.mutateWithAck("todo/forbidden", {
        id: "x",
        title: "doomed",
        done: false,
      });
      yield* engine.push;
      const outcome = yield* handle.acknowledged;
      expect(outcome).toEqual({ _tag: "rejected", reason: "permission revoked" });
    })
  );

  // Real clock: the collector subscribes to the events PubSub on a background
  // fibre, so give it a turn to establish before publishing (a TestClock would
  // freeze the settle/join timeout).
  it.live("mutationEvents emits journaled then acknowledged for a good mutation", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(
        Stream.runCollect(engine.mutationEvents.pipe(Stream.take(2)))
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutateWithAck("todo/set", { id: "y", title: "kept", done: false });
      yield* engine.push;

      const events = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      expect(events.map((event) => event.phase)).toEqual(["journaled", "acknowledged"]);
    })
  );

  it.live("mutationEvents emits journaled then rejected for a poison mutation", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(
        Stream.runCollect(engine.mutationEvents.pipe(Stream.take(2)))
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutateWithAck("todo/forbidden", { id: "x", title: "doomed", done: false });
      yield* engine.push;

      const events = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      expect(events.map((event) => event.phase)).toEqual(["journaled", "rejected"]);
      expect(events[1]!.reason).toBe("permission revoked");
    })
  );

  it.effect("a pending acknowledged is interrupted when the engine scope closes", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      // Build the engine in a nested scope so we can close it independently.
      const handle = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngine(handler, store);
          yield* engine.subscribe(allTodos);
          return yield* engine.mutateWithAck("todo/set", {
            id: "y",
            title: "never pushed",
            done: false,
          });
        })
      );
      // The scope closed without a push: the finalizer interrupts the deferred,
      // so awaiting the outcome fails with an interruption rather than hanging.
      const exit = yield* Effect.exit(handle.acknowledged);
      assert(Exit.isFailure(exit), "awaiting the outcome should fail");
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    })
  );

  it.effect("plain mutate still journals and renders optimistically", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "y", title: "kept", done: false });
      expect(yield* store.pendingMutations).toHaveLength(1);
      const view = yield* engine.query(allTodos);
      expect(view.map((row) => row.id)).toEqual(["y"]);
    })
  );
});
