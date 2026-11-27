/**
 * Retry/backoff policies: the sync loop survives transient
 * transport failures, leaves non-transient errors alone, re-establishes a
 * failed poke stream, and surfaces terminal failures, counting each in the
 * engine's metrics. Every case runs on the TestClock.
 */
import * as P from "effect/Predicate";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { StoreError, TransportError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Poke } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
import { ClientTransport, makeInMemory, type ClientTransport as CT } from "../Transport.js";
import type { ServerHandler } from "../Transport.js";
import { idOf, titleOf } from "./shapes.js";
import { ClientGroupId, RowId } from "../Protocol.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const setTodo = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (todo: Todo, writer) => writer.put("todos", RowId.make(todo.id), todo),
  },
]);

const backendHandlers = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", RowId.make(idOf(args)), args)),
} satisfies Record<string, MemoryBackend.BackendHandler>;

const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

const makeServer = Effect.fn("makeServer")(function* (): Effect.fn.Return<
  ServerHandler,
  never,
  Scope.Scope
> {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, authPolicy),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const allTodos = Subset.make({ collection: "todos" });
const isTransient = (error: { readonly _tag: string }): boolean =>
  P.isTagged(error, "TransportError");
const fast: Schedule.Schedule<unknown> = Schedule.max([
  Schedule.spaced(Duration.millis(10)),
  Schedule.recurs(5),
]);

describe("retry/backoff timing", () => {
  it.effect("default policy backs off exponentially (1s then 2s)", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const flaky = Effect.fn("flaky")(function* () {
        const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
        if (n < 3) return yield* new TransportError({ message: "transient" });
        return "ok";
      });
      const fiber = yield* Effect.forkChild(
        flaky().pipe(
          Effect.retry({ schedule: ClientEngineModule.defaultRetryPolicy, while: isTransient })
        )
      );
      yield* TestClock.adjust(Duration.millis(1)); // first attempt runs
      expect(yield* Ref.get(attempts)).toBe(1);
      yield* TestClock.adjust(Duration.seconds(1)); // first retry after 1s
      expect(yield* Ref.get(attempts)).toBe(2);
      yield* TestClock.adjust(Duration.seconds(2)); // second retry after 2s
      expect(yield* Ref.get(attempts)).toBe(3);
      expect(yield* Fiber.join(fiber)).toBe("ok");
    })
  );

  it.effect("a non-transient error is not retried", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const failing = Effect.fn("failing")(function* () {
        yield* Ref.update(attempts, (x) => x + 1);
        return yield* new StoreError({ message: "permanent" });
      });
      const exit = yield* Effect.exit(
        failing().pipe(
          Effect.retry({ schedule: ClientEngineModule.defaultRetryPolicy, while: isTransient })
        )
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* Ref.get(attempts)).toBe(1); // ran exactly once
    })
  );
});

const pullRetries = Telemetry.syncRetries("pull");
const pokeRetries = Telemetry.syncRetries("pokes");
const countOf = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Metric.value(metric).pipe(Effect.map((state) => state.count));

describe("retry integration", () => {
  it.effect("a pull that fails twice then succeeds converges without app intervention", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      // Commit a remote write first so a successful pull has something to bring.
      const writer = yield* Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const base = yield* makeInMemory(handler, ClientGroupId.make("group-writer"));
        const engine = yield* ClientEngineModule.make({
          clientId: "writer",
          clientGroupId: ClientGroupId.make("group-writer"),
          mutators: setTodo,
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, base)
        );
        return engine;
      });
      yield* writer.subscribe(allTodos);
      yield* writer.mutate("todo/set", { id: "1", title: "remote", done: false });
      yield* writer.push;

      // Reader: pull fails twice with TransportError, then delegates.
      const store = yield* ClientStoreModule.makeMemory;
      const base = yield* makeInMemory(handler, ClientGroupId.make("group-reader"));
      const failuresLeft = yield* Ref.make(2);
      const flaky: CT = {
        push: base.push,
        pull: (request) =>
          Effect.flatMap(
            Ref.getAndUpdate(failuresLeft, (n) => Math.max(0, n - 1)),
            (left) =>
              left > 0
                ? Effect.fail(new TransportError({ message: "transient" }))
                : base.pull(request)
          ),
        pokes: Stream.empty,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const reader = yield* ClientEngineModule.make({
        clientId: "reader",
        clientGroupId: ClientGroupId.make("group-reader"),
        mutators: setTodo,
        retry: { pull: fast },
        syncLoop: { pullInterval: Duration.millis(50) },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, flaky)
      );
      yield* reader.subscribe(allTodos);
      const retriesBefore = yield* countOf(pullRetries);
      yield* reader.runSync;

      // The first pull fails twice, retries 10ms apart, then converges.
      yield* TestClock.adjust(Duration.millis(200));
      const seen = yield* reader.query(allTodos);
      expect(seen.map((row) => titleOf(row.value))).toEqual(["remote"]);
      expect(yield* Ref.get(failuresLeft)).toBe(0);
      expect((yield* countOf(pullRetries)) - retriesBefore).toBe(2);
    })
  );

  it.effect("retry exhaustion is observable via syncFailures and the metrics", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      const store = yield* ClientStoreModule.makeMemory;
      const base = yield* makeInMemory(handler, ClientGroupId.make("group-down"));
      // A transport whose pull never recovers.
      const down: CT = {
        push: base.push,
        pull: () => Effect.fail(new TransportError({ message: "down" })),
        pokes: Stream.empty,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const engine = yield* ClientEngineModule.make({
        clientId: "c",
        clientGroupId: ClientGroupId.make("group-down"),
        mutators: setTodo,
        retry: { pull: Schedule.max([Schedule.recurs(2), Schedule.spaced(Duration.millis(5))]) },
        syncLoop: { pullInterval: Duration.millis(50) },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, down)
      );
      yield* engine.subscribe(allTodos);

      const before = yield* countOf(Telemetry.syncFailuresTotal);
      const retriesBefore = yield* countOf(pullRetries);
      const collected = yield* Effect.forkChild(Stream.runHead(engine.syncFailures));
      yield* engine.runSync;

      yield* TestClock.adjust(Duration.millis(200));
      const failure = yield* Fiber.join(collected);
      expect(failure._tag).toBe("Some");
      assert(Option.isSome(failure), "a sync failure should be reported");
      expect(failure.value.operation).toBe("pull");
      // The point-in-time record holds it too.
      const recent = yield* engine.recentSyncFailures;
      expect(recent.map((entry) => entry.operation)).toContain("pull");
      const failed = (yield* countOf(Telemetry.syncFailuresTotal)) - before;
      expect(failed).toBeGreaterThan(0);
      // Two retries per exhausted pull: the attempt that exhausts the policy is
      // a failure, not a retry.
      expect((yield* countOf(pullRetries)) - retriesBefore).toBe(2 * failed);
    })
  );

  it.effect("a failed poke stream re-establishes and a later poke triggers a pull", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      // Remote write to converge on once the poke lands.
      const w = yield* Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const base = yield* makeInMemory(handler, ClientGroupId.make("group-w"));
        const engine = yield* ClientEngineModule.make({
          clientId: "w",
          clientGroupId: ClientGroupId.make("group-w"),
          mutators: setTodo,
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, base)
        );
        return engine;
      });
      yield* w.subscribe(allTodos);
      yield* w.mutate("todo/set", { id: "9", title: "poked", done: false });
      yield* w.push;

      const store = yield* ClientStoreModule.makeMemory;
      const base = yield* makeInMemory(handler, ClientGroupId.make("group-r"));
      const subs = yield* Ref.make(0);
      const poke: Poke = { reason: "test" };
      // First subscription to pokes fails; the second (after retry) emits a poke.
      const flakyPokes = Stream.unwrap(
        Ref.updateAndGet(subs, (n) => n + 1).pipe(
          Effect.map((n) =>
            n === 1
              ? Stream.fail(new TransportError({ message: "poke stream down" }))
              : Stream.make(poke)
          )
        )
      );
      const flaky: CT = {
        push: base.push,
        pull: base.pull,
        pokes: flakyPokes,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const reader = yield* ClientEngineModule.make({
        clientId: "r",
        clientGroupId: ClientGroupId.make("group-r"),
        mutators: setTodo,
        retry: { pokes: fast },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, flaky)
      );
      yield* reader.subscribe(allTodos);
      const retriesBefore = yield* countOf(pokeRetries);
      const pokesBefore = yield* countOf(Telemetry.pokesReceivedTotal);
      const latencyBefore = (yield* Metric.value(Telemetry.pokeLatencyMs)).count;
      yield* reader.runSync;

      yield* TestClock.adjust(Duration.millis(200));
      expect(yield* Ref.get(subs)).toBeGreaterThan(1); // re-established
      const seen = yield* reader.query(allTodos);
      expect(seen.map((row) => titleOf(row.value))).toEqual(["poked"]);
      expect((yield* countOf(pokeRetries)) - retriesBefore).toBe(1);
      expect((yield* countOf(Telemetry.pokesReceivedTotal)) - pokesBefore).toBe(1);
      expect((yield* Metric.value(Telemetry.pokeLatencyMs)).count - latencyBefore).toBe(1);
    })
  );
});
