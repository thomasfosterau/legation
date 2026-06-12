/**
 * End-to-end engine tests: client mutates optimistically → journal → push →
 * memory backend applies authoritatively → CVR diff → pull patch → rebase.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Scope } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

// Shared mutator contract; local and backend implementations align here,
// but nothing requires them to (the backend is authoritative).
const setTodo = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => {
      const todo = args as Todo;
      return writer.put("todos", todo.id, todo);
    },
  },
  {
    mutator: Mutator.make("todo/remove", Schema.Unknown),
    local: (args, writer) => writer.del("todos", (args as { id: string }).id),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
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

const makeClient = (handler: ServerHandler, name: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, `group-${name}`);
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators: setTodo,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const allTodos = Subset.make({ collection: "todos" });

describe("ClientEngine ↔ SyncServer end to end", () => {
  it.effect("optimistic write → push → pull → confirmed (journal drained)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "write tests", done: false });

      // Optimistic: visible locally before any network.
      const optimistic = yield* engine.query(allTodos);
      expect(optimistic.map((row) => row.id)).toEqual(["1"]);

      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);

      yield* engine.pull;
      const confirmed = yield* store.listRows("todos");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.version).toBe(1);

      // Second pull: CVR makes the patch empty (cookie advanced, same rows).
      const before = yield* store.getCookie;
      yield* engine.pull;
      expect(yield* store.getCookie).not.toBe(before);
      expect(yield* store.listRows("todos")).toHaveLength(1);
    })
  );

  it.effect("a second client group pulls the first group's committed writes", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      const b = yield* makeClient(handler, "b");
      yield* a.engine.subscribe(allTodos);
      yield* b.engine.subscribe(allTodos);

      yield* a.engine.mutate("todo/set", { id: "1", title: "shared", done: false });
      yield* a.engine.push;

      yield* b.engine.pull;
      const seen = yield* b.engine.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["shared"]);
    })
  );

  it.effect("subscriptions narrow by predicate; departed rows are deleted", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      const openOnly = Subset.make({ collection: "todos", where: Predicate.eq("done", false) });
      yield* engine.subscribe(openOnly);

      yield* engine.mutate("todo/set", { id: "1", title: "open", done: false });
      yield* engine.mutate("todo/set", { id: "2", title: "closed", done: true });
      yield* engine.push;
      yield* engine.pull;
      expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["1"]);

      // Completing the open todo removes it from the subscribed subset.
      yield* engine.mutate("todo/set", { id: "1", title: "open", done: true });
      yield* engine.push;
      yield* engine.pull;
      expect(yield* store.listRows("todos")).toEqual([]);
    })
  );

  it.effect("rebase: pending local mutations stay visible over pulled state", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      yield* a.engine.subscribe(allTodos);
      yield* a.engine.mutate("todo/set", { id: "1", title: "v1", done: false });
      yield* a.engine.push;

      // A second pending (unpushed) mutation must survive the pull (rebase).
      yield* a.engine.mutate("todo/set", { id: "2", title: "pending", done: false });
      yield* a.engine.pull;

      const view = yield* a.engine.query(allTodos);
      expect(view.map((row) => row.id).toSorted()).toEqual(["1", "2"]);
      expect(yield* a.store.pendingMutations).toHaveLength(1);
    })
  );

  it.effect("unauthorized collections are denied by default", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(Subset.make({ collection: "secrets" }));
      const result = yield* Effect.exit(engine.pull);
      expect(result._tag).toBe("Failure");
    })
  );
});
