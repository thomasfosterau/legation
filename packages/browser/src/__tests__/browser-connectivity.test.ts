/**
 * @vitest-environment jsdom
 *
 * BrowserConnectivity (issue #33): layering `navigator.onLine` + focus signals
 * onto a `ClientTransport` makes the sync loop's reconnect/focus triggers fire.
 * Signals arrive on background fibres, so the suite uses `it.live` (wall time).
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

describe("BrowserConnectivity (#33)", () => {
  it.live("online/offline drives status; reconnect triggers push+pull; focus triggers pull", () =>
    Effect.gen(function* () {
      setVisible();
      const handler = yield* makeServer;
      const store = yield* ClientStore.makeMemory;
      const base = yield* Transport.makeInMemory(handler, "group-a");

      const pushes = yield* Ref.make(0);
      const pulls = yield* Ref.make(0);
      // Suppress server pokes so only the browser signals drive the loop.
      const counted: Transport.ClientTransport = {
        push: (request) =>
          Ref.update(pushes, (n) => n + 1).pipe(Effect.andThen(base.push(request))),
        pull: (request) => Ref.update(pulls, (n) => n + 1).pipe(Effect.andThen(base.pull(request))),
        pokes: Stream.empty,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const transport = yield* BrowserConnectivity.withBrowserConnectivity(counted);

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
      // Initial connected status triggers a push+pull with an empty journal.
      yield* Effect.sleep(Duration.millis(20));

      // A pending mutation waits; going offline must not push it.
      yield* engine.mutate("todo/set", { id: "1", title: "offline edit", done: false });
      window.dispatchEvent(new Event("offline"));
      yield* Effect.sleep(Duration.millis(20));
      expect(yield* Ref.get(pushes)).toBe(0);
      expect(yield* store.pendingMutations).toHaveLength(1);

      // Coming back online triggers push+pull: the journal drains.
      window.dispatchEvent(new Event("online"));
      yield* Effect.sleep(Duration.millis(40));
      expect(yield* Ref.get(pushes)).toBe(1);
      expect(yield* store.pendingMutations).toEqual([]);

      // A return-to-visible surfaces a poke, which the loop turns into a pull.
      const pullsBefore = yield* Ref.get(pulls);
      document.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.sleep(Duration.millis(40));
      expect(yield* Ref.get(pulls)).toBeGreaterThan(pullsBefore);
    })
  );
});
