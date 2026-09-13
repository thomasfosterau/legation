/**
 * Sync-loop scheduling (issue #33): push-on-mutate debounce, interval pull as
 * the correctness backstop, and scoped interruption of the scheduling fibres.
 * These fibres run on real timers, so the suite uses `it.live` (wall time).
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Ref, Schema, Scope, Stream } from "effect";
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
    // empty journal before reaching the transport).
    const transport: ClientTransport = {
      push: (request) =>
        (opts?.counters ? Ref.update(opts.counters.push, (n) => n + 1) : Effect.void).pipe(
          Effect.andThen(base.push(request))
        ),
      pull: (request) =>
        (opts?.counters ? Ref.update(opts.counters.pull, (n) => n + 1) : Effect.void).pipe(
          Effect.andThen(base.pull(request))
        ),
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

// Poll until the condition holds (generous under parallel-suite load; passing
// runs exit early) — fixed post-debounce sleeps flake when workers contend.
const eventually = (condition: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (yield* condition) return;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

describe("sync-loop scheduling (#33)", () => {
  it.live("auto-pushes a mutation with no app-level push call", () =>
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
      yield* Effect.sleep(Duration.millis(30));

      yield* engine.mutate("todo/set", { id: "1", title: "auto", done: false });
      // After the debounce window the journal drains without an app push.
      yield* eventually(Effect.map(Ref.get(push), (count) => count === 1));
      expect(yield* Ref.get(push)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.live(
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
        yield* Effect.sleep(Duration.millis(30));

        yield* engine.mutate("todo/set", { id: "1", title: "a", done: false });
        yield* engine.mutate("todo/set", { id: "2", title: "b", done: false });
        // Comfortably longer than any debounce window used elsewhere in this
        // suite (30-150ms): with no `syncLoop` options, nothing auto-pushes.
        yield* Effect.sleep(Duration.millis(1000));

        expect(yield* Ref.get(push)).toBe(0);
        expect(yield* store.pendingMutations).toHaveLength(2);
      })
  );

  it.live("coalesces a burst of mutations into a single push", () =>
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
      yield* Effect.sleep(Duration.millis(30));

      yield* engine.mutate("todo/set", { id: "1", title: "a", done: false });
      yield* engine.mutate("todo/set", { id: "2", title: "b", done: false });
      yield* engine.mutate("todo/set", { id: "3", title: "c", done: false });
      // Inside the (widened) window nothing has been pushed yet.
      yield* Effect.sleep(Duration.millis(20));
      expect(yield* Ref.get(push)).toBe(0);
      expect(yield* store.pendingMutations).toHaveLength(3);
      // The window closes: exactly one push drains all three.
      yield* eventually(Effect.map(Ref.get(push), (count) => count >= 1));
      expect(yield* Ref.get(push)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.live("converges on remote changes over interval pull alone (no pokes)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      const b = yield* makeClient(
        handler,
        "b",
        { pullInterval: Duration.millis(25) },
        {
          pokes: Stream.empty,
        }
      );
      yield* a.engine.subscribe(allTodos);
      yield* b.engine.subscribe(allTodos);
      yield* b.engine.runSync;
      yield* Effect.sleep(Duration.millis(10)); // initial connect-pull settles

      // A commits a write; B receives no pokes, so only its interval pull can
      // converge it.
      yield* a.engine.mutate("todo/set", { id: "x", title: "remote", done: false });
      yield* a.engine.push;

      yield* Effect.sleep(Duration.millis(90));
      const seen = yield* b.engine.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["remote"]);
    })
  );

  it.live("interrupts scheduling fibres when the engine scope closes", () =>
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

      yield* Effect.sleep(Duration.millis(90));
      const before = yield* Ref.get(pull);
      expect(before).toBeGreaterThan(1); // interval fired repeatedly

      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep(Duration.millis(90));
      // No further pulls after the scope closed: the fibre was interrupted.
      expect(yield* Ref.get(pull)).toBe(before);
    })
  );
});
