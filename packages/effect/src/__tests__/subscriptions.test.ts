/**
 * Subscriptions tests: reference-counted acquire/release with a TTL grace
 * period, and preload (pinned for the session). Time is driven by TestClock so
 * the grace expiry is deterministic; "dropped" is observed behaviorally — once
 * unsubscribed, the next pull removes the rows from the mirror.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subscriptions from "../Subscriptions.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const setTodo = Mutator.make("todo/set", Schema.Unknown);
const mutators = Mutator.registry([
  { mutator: setTodo, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);
const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<ServerHandler, never, import("effect").Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* MemoryBackend.make(handlers);
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
  }
);

const makeClient = (handler: ServerHandler) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-1");
    return yield* ClientEngineModule.make({
      clientId: "client-1",
      clientGroupId: "group-1",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const allTodos = Subset.make({ collection: "todos" });
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id);

const setup = Effect.gen(function* () {
  const engine = yield* makeClient(yield* makeServer);
  yield* engine.mutate("todo/set", { id: "1", title: "a" });
  yield* engine.push;
  const subs = yield* Subscriptions.make(engine, { ttl: Duration.minutes(5) });
  return { engine, subs };
});

describe("Subscriptions", () => {
  it.effect("drops a released subscription after the TTL grace", () =>
    Effect.gen(function* () {
      const { engine, subs } = yield* setup;

      const handle = yield* subs.acquire(allTodos);
      yield* engine.pull;
      expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);

      yield* handle.release;
      yield* engine.pull;
      // Still within the grace window — rows retained.
      expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);

      yield* TestClock.adjust(Duration.minutes(5));
      yield* engine.pull;
      // Grace elapsed: unsubscribed, so the next pull removed the rows.
      expect(ids(yield* engine.query(allTodos))).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("re-acquiring within the grace window cancels the drop", () =>
    Effect.gen(function* () {
      const { engine, subs } = yield* setup;

      const first = yield* subs.acquire(allTodos);
      yield* engine.pull;
      yield* first.release;
      // Re-acquire before the grace elapses.
      yield* subs.acquire(allTodos);

      yield* TestClock.adjust(Duration.minutes(10));
      yield* engine.pull;
      expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);
    }).pipe(Effect.scoped)
  );

  it.effect("preload pins a subscription for the session", () =>
    Effect.gen(function* () {
      const { engine, subs } = yield* setup;

      yield* subs.preload(allTodos);
      yield* engine.pull;
      yield* TestClock.adjust(Duration.minutes(30));
      yield* engine.pull;
      expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);
    }).pipe(Effect.scoped)
  );
});
