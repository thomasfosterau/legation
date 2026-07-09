/**
 * Introspection (#45): `EngineIntrospection` reflects engine + store state
 * (subscriptions, journal, cookie, collections), the unified `engineEvents`
 * stream emits the sync lifecycle in order, `mutationEvents` (#36) stays a
 * subset of it, the server introspection lists active groups/subsets/CVR
 * sizes, and the new `legation_*` metrics move on a push/pull cycle.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Metric, Schema, Scope, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import type { EngineEvent } from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as Introspection from "../Introspection.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
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
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServerWithIntrospection = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.makeWithIntrospection.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> =
  makeServerWithIntrospection.pipe(Effect.map((built) => built.handler));

const makeClient = (handler: ServerHandler, name: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, `group-${name}`);
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const allTodos = Subset.make({ collection: "todos" });

describe("EngineIntrospection (#45)", () => {
  it.effect("subscriptions/journal/cookie/collections reflect engine state", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      const intro = Introspection.make(engine, store);

      yield* engine.subscribe(allTodos);
      expect((yield* intro.subscriptions).map((s) => s.collection)).toEqual(["todos"]);

      yield* engine.mutate("todo/set", { id: "1", title: "write tests", done: false });
      expect((yield* intro.journal).map((m) => m.mutationId)).toEqual([1]);
      expect(yield* intro.cookie).toBeUndefined();

      yield* engine.push;
      yield* engine.pull;
      expect(yield* intro.journal).toEqual([]);
      expect(yield* intro.cookie).toBeDefined();
      expect(yield* intro.collections).toEqual(["todos"]);
    })
  );

  // Real clock: the collector subscribes to the events PubSub on a background
  // fibre, so give it a turn to establish before the cycle publishes.
  it.live("engineEvents emits the lifecycle in order for mutate → push → pull", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      const intro = Introspection.make(engine, store);
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(
        Stream.runCollect(intro.events.pipe(Stream.take(7)))
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;
      yield* engine.pull;

      const events = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      // No `ViewRebuilt` after `MutationJournaled` (#109): a mutate now
      // publishes a delta `Patch` onto the cached overlay rather than a
      // `Rebuild`, so it never emits `ViewRebuilt` at all.
      expect(events.map((event: EngineEvent) => event._tag)).toEqual([
        "MutationJournaled",
        "PushStarted",
        // #116: every journaled mutation now settles (not just `mutateWithAck`
        // ones), so a plain `mutate` also reports `MutationAcknowledged`.
        "MutationAcknowledged",
        "ViewRebuilt",
        "PushCompleted",
        "PullStarted",
        "PullCompleted",
      ]);
    })
  );

  it.live("mutationEvents (#36) is a filtered projection of the one hub", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(
        Stream.runCollect(engine.mutationEvents.pipe(Stream.take(1)))
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });

      const events = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      expect(events.map((event) => event.phase)).toEqual(["journaled"]);
    })
  );
});

describe("ServerIntrospection (#45)", () => {
  it.effect("lists active groups, their subsets, and CVR sizes after a pull", () =>
    Effect.gen(function* () {
      const { handler, introspection } = yield* makeServerWithIntrospection;
      const { engine } = yield* makeClient(handler, "a");

      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "shared", done: false });
      yield* engine.push;
      yield* engine.pull;

      const groups = yield* introspection.groups;
      const group = groups.find((g) => g.clientGroupId === "group-a");
      expect(group).toBeDefined();
      expect(group?.subsets.map((s) => s.collection)).toEqual(["todos"]);
      expect(group?.cvrSize).toBe(1);
      expect(yield* introspection.pokesPublished).toBeGreaterThanOrEqual(0);
    })
  );
});

const metricSnapshot = Effect.all({
  pushMutations: Metric.value(Telemetry.pushMutations),
  pullPatchOps: Metric.value(Telemetry.pullPatchOps),
  rebase: Metric.value(Telemetry.rebaseDurationMs),
});

describe("Introspection metrics (#45)", () => {
  it.effect("the new legation_* metrics move on a push/pull cycle", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "m");
      yield* engine.subscribe(allTodos);

      const before = yield* metricSnapshot;
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      // Journal depth is an absolute gauge: one pending mutation now.
      expect((yield* Metric.value(Telemetry.journalDepth)).value).toBe(1);
      yield* engine.query(allTodos); // forces a materialise → rebase timing
      yield* engine.push;
      yield* engine.pull;
      const after = yield* metricSnapshot;

      expect(after.pushMutations.count).toBe(before.pushMutations.count + 1);
      expect(after.pullPatchOps.count).toBe(before.pullPatchOps.count + 1);
      expect(after.rebase.count).toBeGreaterThan(before.rebase.count);
      // The journal drained, so the gauge is back to zero.
      expect((yield* Metric.value(Telemetry.journalDepth)).value).toBe(0);
    })
  );
});
