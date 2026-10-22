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
 *
 * The worker case (#328) has no `window`: its `navigator.onLine` is a stub the
 * test flips, and the probe that BrowserConnectivity runs in its place is
 * driven by the same TestClock.
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
import { vi } from "vite-plus/test";
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

// A service worker's globals: no `window` or `document`, and a `navigator`
// whose `onLine` the test flips. Restored when the enclosing scope closes.
const stubWorkerGlobals = (navigatorStub: { onLine: boolean }) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubGlobal("window", undefined);
      vi.stubGlobal("document", undefined);
      vi.stubGlobal("navigator", navigatorStub);
    }),
    () => Effect.sync(() => vi.unstubAllGlobals())
  );

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

  it.effect(
    "worker (no window): probed navigator.onLine flips drive status and the reconnect push (#328)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const navigatorStub = { onLine: true };
          yield* stubWorkerGlobals(navigatorStub);
          const handler = yield* makeServer;
          const store = yield* ClientStore.makeMemory;
          const base = yield* Transport.makeInMemory(handler, "group-a");

          const pushes = yield* Ref.make(0);
          const pulls = yield* Ref.make(0);
          const counted: Transport.ClientTransport = {
            push: (request) => base.push(request).pipe(Effect.tap(() => count(pushes))),
            pull: (request) => base.pull(request).pipe(Effect.tap(() => count(pulls))),
            pokes: Stream.empty,
            status: base.status,
            statusChanges: base.statusChanges,
          };
          // A 100 ms probe keeps each flip within the advanceUntil step budget.
          const connectivity = yield* BrowserConnectivity.withBrowserConnectivity(counted, {
            pollInterval: "100 millis",
          });
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
          yield* advanceUntil(atLeast(pulls, 1));
          expect(yield* Ref.get(pushes)).toBe(0);

          yield* engine.mutate("todo/set", { id: "1", title: "offline edit", done: false });
          // A worker has no `offline` event: the flip is found by the probe.
          navigatorStub.onLine = false;
          yield* advanceUntil(hasSeen(["connected", "disconnected"]));
          expect(yield* Ref.get(pushes)).toBe(0);
          expect(yield* store.pendingMutations).toHaveLength(1);

          // The probe sees the return; the reconnect leg pushes, then pulls.
          navigatorStub.onLine = true;
          yield* advanceUntil(atLeast(pulls, 2));
          expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected", "connected"]);
          expect(yield* Ref.get(pushes)).toBe(1);
          expect(yield* store.pendingMutations).toEqual([]);
        })
      )
  );

  it.effect(
    "worker: a navigator reconnect edge emits connected and pushes at once, even when the carrier reports disconnected (#328)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const navigatorStub = { onLine: true };
          yield* stubWorkerGlobals(navigatorStub);
          const handler = yield* makeServer;
          const store = yield* ClientStore.makeMemory;
          const base = yield* Transport.makeInMemory(handler, "group-a");

          const pushes = yield* Ref.make(0);
          const pulls = yield* Ref.make(0);
          // A carrier whose own signal reads "disconnected" throughout, as
          // `Transport.withFallback` does after both legs have failed. Its
          // requests still reach the in-memory server, so a push that goes out
          // is observable.
          const carrier: Transport.ClientTransport = {
            push: (request) => base.push(request).pipe(Effect.tap(() => count(pushes))),
            pull: (request) => base.pull(request).pipe(Effect.tap(() => count(pulls))),
            pokes: Stream.empty,
            status: Effect.succeed("disconnected"),
            statusChanges: Stream.concat(Stream.make("disconnected" as const), Stream.never),
          };
          const connectivity = yield* BrowserConnectivity.withBrowserConnectivity(carrier, {
            pollInterval: "100 millis",
          });
          const seen = yield* Ref.make<ReadonlyArray<Transport.ConnectionStatus>>([]);
          const transport: Transport.ClientTransport = {
            ...connectivity,
            statusChanges: connectivity.statusChanges.pipe(
              Stream.tap((status) => Ref.update(seen, (all) => [...all, status]))
            ),
          };

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
          yield* engine.mutate("todo/set", { id: "1", title: "offline edit", done: false });

          // Going offline is seen by the probe; the carrier stays "disconnected",
          // so the combined status does not change and nothing is pushed.
          navigatorStub.onLine = false;
          yield* TestClock.adjust(Duration.millis(200));
          // The probe sees the return. The edge must reach the sync loop as
          // "connected" even though the carrier still reads "disconnected".
          navigatorStub.onLine = true;
          yield* advanceUntil(atLeast(pulls, 1));
          expect(yield* Ref.get(seen)).toEqual(["disconnected", "connected"]);
          expect(yield* Ref.get(pushes)).toBe(1);
          expect(yield* store.pendingMutations).toEqual([]);
        })
      )
  );

  it.effect("worker: an auto-push goes out while status is disconnected, by design (#328)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Offline from the start: the combined status is "disconnected".
        const navigatorStub = { onLine: false };
        yield* stubWorkerGlobals(navigatorStub);
        const handler = yield* makeServer;
        const store = yield* ClientStore.makeMemory;
        const base = yield* Transport.makeInMemory(handler, "group-a");

        const pushes = yield* Ref.make(0);
        const counted: Transport.ClientTransport = {
          push: (request) => base.push(request).pipe(Effect.tap(() => count(pushes))),
          pull: base.pull,
          pokes: Stream.empty,
          status: base.status,
          statusChanges: base.statusChanges,
        };
        const connectivity = yield* BrowserConnectivity.withBrowserConnectivity(counted, {
          pollInterval: "100 millis",
        });

        // Auto-push is armed. Status is not consulted, so the debounced push
        // goes out even though the navigator reads offline.
        const engine = yield* ClientEngine.make({
          clientId: "client-a",
          clientGroupId: "group-a",
          mutators: setTodo,
          syncLoop: { pushDebounce: "10 millis" },
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, connectivity)
        );
        yield* engine.subscribe(allTodos);
        yield* engine.runSync;
        expect(yield* Ref.get(pushes)).toBe(0);

        yield* engine.mutate("todo/set", { id: "1", title: "offline edit", done: false });
        yield* advanceUntil(atLeast(pushes, 1));
        expect(yield* Ref.get(pushes)).toBe(1);
        expect(yield* store.pendingMutations).toEqual([]);
      })
    )
  );
});
