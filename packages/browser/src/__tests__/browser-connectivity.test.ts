/**
 * @vitest-environment jsdom
 *
 * BrowserConnectivity (issue #33): layering `navigator.onLine` + focus signals
 * onto a `ClientTransport` makes the sync loop's reconnect/focus triggers fire.
 *
 * Signals arrive on background fibres. The suite runs under `it.effect` and
 * waits for the specific event each step needs (a completed network leg, the
 * engine seeing a status), advancing the `TestClock` only to yield to those
 * fibres. Nothing waits on wall-clock time, so a loaded machine cannot reorder
 * a step (#282).
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
  InvalidationBus,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as BrowserConnectivity from "../BrowserConnectivity.js";

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

const makeServer: Effect.Effect<Transport.ServerHandler, never, Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* MemoryBackend.make(backendHandlers);
    const cvrStore = yield* Cvr.makeMemoryStore;
    const bus = yield* InvalidationBus.makeInProcess;
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, authPolicy),
      Effect.provideService(Cvr.CvrStore, cvrStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
  }
);

const allTodos = Subset.make({ collection: "todos" });

// jsdom defaults visibilityState to "prerender"; pin it visible so a
// visibilitychange counts as a return-to-visible.
const setVisible = () =>
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });

// Advance the TestClock in 1 ms steps until the condition holds. Each
// `TestClock.adjust` yields to the engine's forked fibres, so in-flight work
// (a status change, a push+pull leg) gets to finish. Time is virtual: the bound
// is a number of steps, not a wall-clock budget, so machine load cannot
// exhaust it.
const advanceUntil = <E>(condition: Effect.Effect<boolean, E>, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxSteps; attempt++) {
      if (yield* condition) return;
      yield* TestClock.adjust(Duration.millis(1));
    }
    if (yield* condition) return;
    return yield* Effect.die(new Error(`advanceUntil: condition never held in ${maxSteps} steps`));
  });

// Transport legs are counted once they have completed, so a count the test
// waits on means the leg's effects (a drained journal) are visible.
const count = (counter: Ref.Ref<number>) => Ref.update(counter, (n) => n + 1);

const atLeast = (counter: Ref.Ref<number>, n: number) =>
  Effect.map(Ref.get(counter), (value) => value >= n);

describe("BrowserConnectivity (#33)", () => {
  it.effect("online/offline drives status; reconnect triggers push+pull; focus triggers pull", () =>
    Effect.gen(function* () {
      setVisible();
      const handler = yield* makeServer;
      const store = yield* ClientStore.makeMemory;
      const base = yield* Transport.makeInMemory(handler, "group-a");

      const pushes = yield* Ref.make(0);
      const pulls = yield* Ref.make(0);
      // Suppress server pokes so only the browser signals drive the loop.
      const counted: Transport.ClientTransport = {
        push: (request) => base.push(request).pipe(Effect.tap(() => count(pushes))),
        pull: (request) => base.pull(request).pipe(Effect.tap(() => count(pulls))),
        pokes: Stream.empty,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const connectivity = yield* BrowserConnectivity.withBrowserConnectivity(counted);
      // Record each status the engine's reconnect loop takes from the stream,
      // so the test can wait until the loop has seen a browser event.
      const seen = yield* Ref.make<ReadonlyArray<Transport.ConnectionStatus>>([]);
      const transport: Transport.ClientTransport = {
        ...connectivity,
        statusChanges: connectivity.statusChanges.pipe(
          Stream.tap((status) => Ref.update(seen, (all) => [...all, status]))
        ),
      };
      const hasSeen = (statuses: ReadonlyArray<Transport.ConnectionStatus>) =>
        Effect.map(Ref.get(seen), (all) => statuses.every((status, i) => all[i] === status));

      const engine = yield* ClientEngine.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators: setTodo,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );
      yield* engine.subscribe(allTodos);
      yield* engine.runSync;
      // Initial connected status triggers a push+pull with an empty journal
      // (the push short-circuits before the transport). Wait for the pull to
      // complete, so that leg cannot pick up the mutation below.
      yield* advanceUntil(atLeast(pulls, 1));
      expect(yield* Ref.get(pushes)).toBe(0);

      // A pending mutation waits; going offline must not push it.
      yield* engine.mutate("todo/set", { id: "1", title: "offline edit", done: false });
      window.dispatchEvent(new Event("offline"));
      yield* advanceUntil(hasSeen(["connected", "disconnected"]));
      expect(yield* Ref.get(pushes)).toBe(0);
      expect(yield* store.pendingMutations).toHaveLength(1);

      // Coming back online triggers push+pull: the journal drains. The pull
      // follows the push on the same leg, so its completion means both ran.
      window.dispatchEvent(new Event("online"));
      yield* advanceUntil(atLeast(pulls, 2));
      expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected", "connected"]);
      expect(yield* Ref.get(pushes)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);

      // A return-to-visible surfaces a poke, which the loop turns into a pull.
      const pullsBefore = yield* Ref.get(pulls);
      document.dispatchEvent(new Event("visibilitychange"));
      yield* advanceUntil(atLeast(pulls, pullsBefore + 1));
      expect(yield* Ref.get(pulls)).toBe(pullsBefore + 1);
      expect(yield* Ref.get(pushes)).toBe(1);
    })
  );
});
