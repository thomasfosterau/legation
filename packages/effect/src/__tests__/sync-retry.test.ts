/**
 * Retry/backoff policies (issue #34): the sync loop survives transient
 * transport failures, leaves non-transient errors alone, re-establishes a
 * failed poke stream, and surfaces terminal failures. Backoff *timing* is
 * verified with TestClock; the loop-integration cases use `it.live`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Metric, Ref, Schedule, Schema, Scope, Stream } from "effect";
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

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const setTodo = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => {
      const todo = args as Todo;
      return writer.put("todos", todo.id, todo);
    },
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
};

const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
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
const isTransient = (error: { readonly _tag: string }): boolean => error._tag === "TransportError";
const fast: Schedule.Schedule<unknown, unknown> = Schedule.max([
  Schedule.spaced(Duration.millis(10)),
  Schedule.recurs(5),
]);

describe("retry/backoff timing (#34)", () => {
  it.effect("default policy backs off exponentially (1s then 2s)", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const flaky = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
        if (n < 3) return yield* Effect.fail(new TransportError({ message: "transient" }));
        return "ok";
      });
      const fiber = yield* Effect.forkChild(
        flaky.pipe(
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
      const failing = Effect.gen(function* () {
        yield* Ref.update(attempts, (x) => x + 1);
        return yield* Effect.fail(new StoreError({ message: "permanent" }));
      });
      const exit = yield* Effect.exit(
        failing.pipe(
          Effect.retry({ schedule: ClientEngineModule.defaultRetryPolicy, while: isTransient })
        )
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* Ref.get(attempts)).toBe(1); // ran exactly once
    })
  );
});

describe("retry integration (#34)", () => {
  it.live("a pull that fails twice then succeeds converges without app intervention", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      // Commit a remote write first so a successful pull has something to bring.
      const writer = yield* Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const base = yield* makeInMemory(handler, "group-writer");
        const engine = yield* ClientEngineModule.make({
          clientId: "writer",
          clientGroupId: "group-writer",
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
      const base = yield* makeInMemory(handler, "group-reader");
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
        clientGroupId: "group-reader",
        mutators: setTodo,
        retry: { pull: fast },
        syncLoop: { pullInterval: Duration.millis(50) },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, flaky)
      );
      yield* reader.subscribe(allTodos);
      yield* reader.runSync;

      // The first interval pull fails twice, retries, then converges.
      yield* Effect.sleep(Duration.millis(200));
      const seen = yield* reader.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["remote"]);
      expect(yield* Ref.get(failuresLeft)).toBe(0);
    })
  );

  it.live("retry exhaustion is observable via syncFailures and the metric", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const base = yield* makeInMemory(handler, "group-down");
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
        clientGroupId: "group-down",
        mutators: setTodo,
        retry: { pull: Schedule.max([Schedule.recurs(2), Schedule.spaced(Duration.millis(5))]) },
        syncLoop: { pullInterval: Duration.millis(50) },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, down)
      );
      yield* engine.subscribe(allTodos);

      const before = (yield* Metric.value(Telemetry.syncFailuresTotal)).count;
      const collected = yield* Effect.forkChild(Stream.runHead(engine.syncFailures));
      yield* engine.runSync;

      yield* Effect.sleep(Duration.millis(200));
      const failure = yield* Fiber.join(collected);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") expect(failure.value.operation).toBe("pull");
      const after = (yield* Metric.value(Telemetry.syncFailuresTotal)).count;
      expect(after).toBeGreaterThan(before);
    })
  );

  it.live("a failed poke stream re-establishes and a later poke triggers a pull", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      // Remote write to converge on once the poke lands.
      const w = yield* Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const base = yield* makeInMemory(handler, "group-w");
        const engine = yield* ClientEngineModule.make({
          clientId: "w",
          clientGroupId: "group-w",
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
      const base = yield* makeInMemory(handler, "group-r");
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
        clientGroupId: "group-r",
        mutators: setTodo,
        retry: { pokes: fast },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, flaky)
      );
      yield* reader.subscribe(allTodos);
      yield* reader.runSync;

      yield* Effect.sleep(Duration.millis(200));
      expect(yield* Ref.get(subs)).toBeGreaterThan(1); // re-established
      const seen = yield* reader.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["poked"]);
    })
  );
});
