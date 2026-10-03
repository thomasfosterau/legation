/**
 * Devtools (#120): the headless core reads live off `Introspection` +
 * `ClientEngine`'s public streams, and its actions drive the same engine
 * effects an app would call directly (`push`/`pull`/`unsubscribe`,
 * `ClientStore.clearRows`) — nothing here is a bespoke wire.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, HashMap, Schema, Stream } from "effect";
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
  InvalidationBus,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import * as Devtools from "../Devtools.js";

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
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const allTodos = Subset.make({ collection: "todos" });

/** The real in-process stack (server + client engine + store), scoped. */
const setup = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvr = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvr),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const store = yield* ClientStore.makeMemory;
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  const devtools = Devtools.make(engine, store);
  return { backend, bus, engine, store, devtools };
});

describe("Devtools.make", () => {
  it.effect("subscriptions/cookie/collections read the same substrate Introspection does", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;
      yield* engine.pull;

      const subscriptions = yield* devtools.subscriptions;
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({ collection: "todos" });

      expect(yield* devtools.cookie).toBeDefined();

      const collections = yield* devtools.collections;
      expect(collections).toEqual([{ name: "todos", rowCount: 1 }]);
    }).pipe(Effect.scoped)
  );

  it.effect("mutationStates streams the journal/mutation timeline, including a settled entry", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;

      const states = yield* Stream.runHead(devtools.mutationStates);
      expect(states._tag).toBe("Some");
      if (states._tag !== "Some") return;
      const entry = [...HashMap.values(states.value)].find((s) => s.mutationId === 1);
      expect(entry?.phase).toBe("acknowledged");
    }).pipe(Effect.scoped)
  );

  it.effect("forcePush/forcePull drive the same engine effects an app would call directly", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });

      yield* devtools.forcePush;
      yield* devtools.forcePull;

      const collections = yield* devtools.collections;
      expect(collections).toEqual([{ name: "todos", rowCount: 1 }]);
    }).pipe(Effect.scoped)
  );

  it.effect("dropSubscription unsubscribes; a later subscriptions read no longer lists it", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);
      expect(yield* devtools.subscriptions).toHaveLength(1);

      yield* devtools.dropSubscription(allTodos);
      expect(yield* devtools.subscriptions).toHaveLength(0);
    }).pipe(Effect.scoped)
  );

  it.effect("clearStore empties every confirmed row (the destructive action)", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;
      yield* engine.pull;
      expect(yield* devtools.collections).toEqual([{ name: "todos", rowCount: 1 }]);

      yield* devtools.clearStore;
      expect(yield* devtools.collections).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("an offline control passed to `make` is exposed on the core unchanged", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* setup;
      const offline = {
        setOffline: (_next: boolean) => Effect.void,
        isOffline: Effect.succeed(false),
      };
      const withOffline = Devtools.make(engine, store, { offline });
      expect(withOffline.offline).toBe(offline);

      const withoutOffline = Devtools.make(engine, store);
      expect(withoutOffline.offline).toBeUndefined();
    }).pipe(Effect.scoped)
  );

  // Real clock: the collector subscribes to `events` on a background fiber,
  // so give it a turn to establish before the push/pull publish (mirrors
  // mutation-states-engine.test.ts's own live-collector pattern).
  it.live("events surfaces the sync-lifecycle log live, not as a one-shot read", () =>
    Effect.gen(function* () {
      const { engine, devtools } = yield* setup;
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(devtools.events, 1)));
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });

      const events = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      expect([...events]).toEqual([
        { _tag: "MutationJournaled", clientId: "client-a", mutationId: 1 },
      ]);
    }).pipe(Effect.scoped)
  );
});
