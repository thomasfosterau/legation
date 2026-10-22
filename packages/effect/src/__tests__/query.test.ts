/**
 * Named query tests: a client subscribes by name + args; the server resolves
 * the authoritative subset (shaping/narrowing the client can't override), while
 * the client renders from its own local subset over the rows it was sent.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
import * as Query from "../Query.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly isArchived: boolean;
}

const setTodo = Mutator.make("todo/set", Schema.Unknown);
const mutators = Mutator.registry([
  { mutator: setTodo, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);
const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

// `visibleTodos`: the client renders *all* todos locally; the server narrows to
// the non-archived ones. `todosByStatus`: shaped from client args.
const visibleTodos = Query.make("visibleTodos", Schema.Struct({}));
const todosByStatus = Query.make("todosByStatus", Schema.Struct({ isArchived: Schema.Boolean }));

const queries = Query.registry([
  { query: visibleTodos, local: () => Subset.make({ collection: "todos" }) },
  {
    query: todosByStatus,
    local: (args) =>
      Subset.make({ collection: "todos", where: Predicate.eq("isArchived", args.isArchived) }),
  },
]);

const resolver = Query.resolver([
  {
    query: visibleTodos,
    server: () =>
      Effect.succeed(
        Subset.make({ collection: "todos", where: Predicate.eq("isArchived", false) })
      ),
  },
  {
    query: todosByStatus,
    server: (args) =>
      Effect.succeed(
        Subset.make({ collection: "todos", where: Predicate.eq("isArchived", args.isArchived) })
      ),
  },
]);

const baseServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const withResolver = baseServer.pipe(
  Effect.flatMap((server) => server.pipe(Effect.provideService(Query.QueryResolver, resolver)))
);
const withoutResolver = baseServer.pipe(Effect.flatMap((server) => server));

const makeClient = (handler: ServerHandler) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-1");
    return yield* ClientEngineModule.make({
      clientId: "client-1",
      clientGroupId: "group-1",
      mutators,
      queries,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const seed = (engine: ClientEngineModule.ClientEngine) =>
  Effect.gen(function* () {
    yield* engine.mutate("todo/set", { id: "1", title: "keep", isArchived: false });
    yield* engine.mutate("todo/set", { id: "2", title: "old", isArchived: true });
    yield* engine.push;
  });

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id);

describe("named queries", () => {
  it.effect("the server narrows beyond the client's local query", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* withResolver);
      yield* seed(engine);

      // Local subset is "all todos", but the server's visibleTodos only syncs
      // the non-archived ones, so archived #2 never reaches the mirror.
      yield* engine.subscribeQuery("visibleTodos", {});
      yield* engine.pull;
      expect(ids(yield* engine.queryNamed("visibleTodos", {}))).toEqual(["1"]);
    }).pipe(Effect.scoped)
  );

  it.effect("shapes the subset from client args", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* withResolver);
      yield* seed(engine);

      yield* engine.subscribeQuery("todosByStatus", { isArchived: true });
      yield* engine.pull;
      expect(ids(yield* engine.queryNamed("todosByStatus", { isArchived: true }))).toEqual(["2"]);
    }).pipe(Effect.scoped)
  );

  it.effect("rejects an unknown query name on the client", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* withResolver);
      const error = yield* engine.subscribeQuery("nope", {}).pipe(Effect.flip);
      expect(error._tag).toBe("QueryError");
    }).pipe(Effect.scoped)
  );

  it.effect("fails the pull when no resolver is registered server-side", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* withoutResolver);
      yield* engine.subscribeQuery("visibleTodos", {});
      const error = yield* engine.pull.pipe(Effect.flip);
      expect(error._tag).toBe("TransportError");
    }).pipe(Effect.scoped)
  );
});
