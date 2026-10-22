/**
 * Sync-loop scheduling (issue #33): push-on-mutate debounce, interval pull as
 * the correctness backstop, and scoped interruption of the scheduling fibres.
 *
 * Every case runs under `it.effect`, so the debounce, the interval and the
 * retry schedules all sleep on the `TestClock` and only move when a test
 * advances it. Nothing here waits on wall-clock time, so a loaded machine
 * cannot make a case time out (#309).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
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
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Poke } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

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

interface Counters {
  readonly push: Ref.Ref<number>;
  readonly pull: Ref.Ref<number>;
}

const makeClient = (
  handler: ServerHandler,
  name: string,
  syncLoop?: ClientEngineModule.SyncLoopOptions,
  opts?: { readonly pokes?: Stream.Stream<Poke, never>; readonly counters?: Counters }
) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const base = yield* makeInMemory(handler, `group-${name}`);
    // Count only network legs the engine actually makes (push short-circuits an
    // empty journal before reaching the transport), and count each one once it
    // has completed, so a count the tests wait on means the leg's effects
    // (a drained journal, rows in the store) are already visible.
    const count = (counter: Ref.Ref<number> | undefined) =>
      counter ? Ref.update(counter, (n) => n + 1) : Effect.void;
    const transport: ClientTransport = {
      push: (request) => base.push(request).pipe(Effect.tap(() => count(opts?.counters?.push))),
      pull: (request) => base.pull(request).pipe(Effect.tap(() => count(opts?.counters?.pull))),
      pokes: opts?.pokes ?? base.pokes,
      status: base.status,
      statusChanges: base.statusChanges,
    };
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators: setTodo,
      ...(syncLoop !== undefined ? { syncLoop } : {}),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const allTodos = Subset.make({ collection: "todos" });

// Advance the TestClock in `step` increments until the condition holds. Each
// `TestClock.adjust` also yields to the engine's forked fibres, so this both
// lets in-flight work (the connect push+pull, a debounced push) finish and
// fires the timers due by then. Time is virtual: the bound is a number of
// steps, not a wall-clock budget, so machine load cannot exhaust it.
const advanceUntil = <E>(
  condition: Effect.Effect<boolean, E>,
  step: Duration.Input,
  maxSteps = 200
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxSteps; attempt++) {
      if (yield* condition) return;
      yield* TestClock.adjust(step);
    }
    if (yield* condition) return;
    return yield* Effect.die(new Error(`advanceUntil: condition never held in ${maxSteps} steps`));
  });

// Wait for a condition without moving the clock. Each step is a zero-length
// `TestClock.adjust`, which only yields to the forked fibres, so a leg that
// needs several scheduler turns to finish (its own yields, or forked children)
// is waited on for as long as it takes, while the virtual time stays put. The
// test then asserts the window's edge on the clock, so "not a millisecond
// later" is still checked: a push that starts late never satisfies the
// condition, and the bound fails.
const settle = <E>(condition: Effect.Effect<boolean, E>, maxSteps = 200) =>
  advanceUntil(condition, Duration.millis(0), maxSteps);

const atLeast = (counter: Ref.Ref<number>, n: number) =>
  Effect.map(Ref.get(counter), (count) => count >= n);

describe("sync-loop scheduling (#33)", () => {
  it.effect("auto-pushes a mutation with no app-level push call", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const push = yield* Ref.make(0);
      const pull = yield* Ref.make(0);
      const { engine, store } = yield* makeClient(
        handler,
        "a",
        { pushDebounce: Duration.millis(30) },
        { counters: { push, pull } }
      );
      yield* engine.subscribe(allTodos);
      yield* engine.runSync;
      // Let the initial connect-triggered push+pull (empty journal) settle.
      yield* advanceUntil(atLeast(pull, 1), Duration.millis(1));
      expect(yield* Ref.get(push)).toBe(0);

      yield* engine.mutate("todo/set", { id: "1", title: "auto", done: false });
      // Inside the debounce window nothing has been pushed yet.
      yield* TestClock.adjust(Duration.millis(29));
      expect(yield* Ref.get(push)).toBe(0);
      // The window closes on the next millisecond: the journal drains without
      // an app push, and not a millisecond later.
      yield* TestClock.adjust(Duration.millis(1));
      yield* settle(atLeast(push, 1));
      expect(yield* Ref.get(push)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  // A mutation journaled at any point after `runSync` is auto-pushed (#317).
  // The connect leg's push reads the journal once; the debounce fibre must
  // already be subscribed to the push trigger by the time a later mutation
  // signals it, or the trigger is lost and the mutation sits in the journal.
  // `Client.make` forks `runSync`, so each case runs both forked and awaited,
  // with the mutation journaled after every number of scheduler turns from
  // "before the loop's fibres have run" to "long after they settled". On the
  // TestClock the debounce only elapses when the case advances it, so a
  // missed trigger fails deterministically instead of after a live timeout.
  for (const forked of [true, false]) {
    for (let turns = 0; turns <= 8; turns++) {
      it.effect(
        `auto-pushes a mutation journaled ${turns} turn${turns === 1 ? "" : "s"} after ${forked ? "forking" : "running"} runSync (#317)`,
        () =>
          Effect.gen(function* () {
            const handler = yield* makeServer;
            const push = yield* Ref.make(0);
            const pull = yield* Ref.make(0);
            const { engine, store } = yield* makeClient(
              handler,
              "a",
              { pushDebounce: Duration.millis(30) },
              { counters: { push, pull } }
            );
            if (forked) yield* Effect.forkScoped(engine.runSync.pipe(Effect.orDie));
            else yield* engine.runSync;
            for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow;

            yield* engine.mutate("todo/set", { id: "1", title: "late", done: false });
            // Whichever leg takes it (the connect push, or the debounced push
            // the mutation triggered), the journal drains once the window has
            // elapsed.
            yield* TestClock.adjust(Duration.millis(30));
            yield* settle(atLeast(push, 1));
            expect(yield* store.pendingMutations).toEqual([]);
            expect(yield* Ref.get(push)).toBe(1);
          })
      );
    }
  }

  it.effect(
    "pins the default: an unconfigured connected client never auto-pushes a journaled mutation (#143)",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const push = yield* Ref.make(0);
        const pull = yield* Ref.make(0);
        // No `syncLoop` options at all — the documented default.
        const { engine, store } = yield* makeClient(handler, "a", undefined, {
          counters: { push, pull },
        });
        yield* engine.subscribe(allTodos);
        yield* engine.runSync;
        // Let the initial connect-triggered push+pull (empty journal) settle;
        // the transport is connected throughout (in-memory transport default).
        yield* advanceUntil(atLeast(pull, 1), Duration.millis(1));

        yield* engine.mutate("todo/set", { id: "1", title: "a", done: false });
        yield* engine.mutate("todo/set", { id: "2", title: "b", done: false });
        // Comfortably longer than any debounce window used elsewhere in this
        // suite (30-150ms): with no `syncLoop` options, nothing auto-pushes.
        yield* TestClock.adjust(Duration.millis(1000));

        expect(yield* Ref.get(push)).toBe(0);
        expect(yield* store.pendingMutations).toHaveLength(2);
      })
  );

  it.effect("coalesces a burst of mutations into a single push", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const push = yield* Ref.make(0);
      const pull = yield* Ref.make(0);
      const { engine, store } = yield* makeClient(
        handler,
        "a",
        { pushDebounce: Duration.millis(150) },
        { counters: { push, pull } }
      );
      yield* engine.subscribe(allTodos);
      yield* engine.runSync;
      yield* advanceUntil(atLeast(pull, 1), Duration.millis(1));

      yield* engine.mutate("todo/set", { id: "1", title: "a", done: false });
      yield* engine.mutate("todo/set", { id: "2", title: "b", done: false });
      yield* engine.mutate("todo/set", { id: "3", title: "c", done: false });
      // Up to the last instant of the window nothing has been pushed yet.
      yield* TestClock.adjust(Duration.millis(149));
      expect(yield* Ref.get(push)).toBe(0);
      expect(yield* store.pendingMutations).toHaveLength(3);
      // The window closes on the next millisecond: exactly one push drains all
      // three, and not a millisecond later.
      yield* TestClock.adjust(Duration.millis(1));
      yield* settle(atLeast(push, 1));
      expect(yield* Ref.get(push)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.effect("converges on remote changes over interval pull alone (no pokes)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const push = yield* Ref.make(0);
      const pull = yield* Ref.make(0);
      const a = yield* makeClient(handler, "a");
      const b = yield* makeClient(
        handler,
        "b",
        { pullInterval: Duration.millis(25) },
        { pokes: Stream.empty, counters: { push, pull } }
      );
      yield* a.engine.subscribe(allTodos);
      yield* b.engine.subscribe(allTodos);
      yield* b.engine.runSync;
      // The connect pull and the interval's first pull settle.
      yield* advanceUntil(atLeast(pull, 2), Duration.millis(1));

      // A commits a write; B receives no pokes, so only its interval pull can
      // converge it.
      yield* a.engine.mutate("todo/set", { id: "x", title: "remote", done: false });
      yield* a.engine.push;

      const titles = Effect.map(b.engine.query(allTodos), (rows) =>
        rows.map((row) => (row.value as Todo).title)
      );
      yield* advanceUntil(
        Effect.map(titles, (seen) => seen.length > 0),
        Duration.millis(25)
      );
      expect(yield* titles).toEqual(["remote"]);
    })
  );

  it.effect("interrupts scheduling fibres when the engine scope closes", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const push = yield* Ref.make(0);
      const pull = yield* Ref.make(0);
      const scope = yield* Scope.make();
      const { engine } = yield* makeClient(
        handler,
        "a",
        { pullInterval: Duration.millis(20) },
        { counters: { push, pull } }
      );
      yield* engine.subscribe(allTodos);
      // Fork the loop into a scope we control, not the test's.
      yield* engine.runSync.pipe(Effect.provideService(Scope.Scope, scope));

      // The interval fires repeatedly: the connect pull plus at least three
      // interval pulls.
      yield* advanceUntil(atLeast(pull, 4), Duration.millis(20));

      yield* Scope.close(scope, Exit.void);
      // Read the count once the scope has closed, so a pull completing while
      // the fibres are being interrupted is already in it.
      const before = yield* Ref.get(pull);
      expect(before).toBeGreaterThanOrEqual(4);
      // Ten more intervals of virtual time: no further pulls after the scope
      // closed, because the fibre was interrupted.
      for (let interval = 0; interval < 10; interval++) {
        yield* TestClock.adjust(Duration.millis(20));
      }
      expect(yield* Ref.get(pull)).toBe(before);
    })
  );
});
