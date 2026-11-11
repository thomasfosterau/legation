/**
 * Subscription totals (#210, ADR-0029's #210 amendment): a pull reports each
 * subscription's total, the rows its `where` matches under the server's auth
 * filter whatever its window, and the engine keeps the last pull's totals for
 * `totalOf`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Scope from "effect/Scope";
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
  readonly done: boolean;
  readonly rank: number;
}

const todos: ReadonlyArray<Todo> = [
  { id: "t-1", done: false, rank: 1 },
  { id: "t-2", done: true, rank: 2 },
  { id: "t-3", done: false, rank: 3 },
  { id: "t-4", done: false, rank: 4 },
  { id: "t-5", done: true, rank: 5 },
];

const handlers = {
  "todo/set": (args, writer) => {
    // SAFETY: every `todo/set` this file applies carries a `Todo`.
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
} satisfies Record<string, MemoryBackend.BackendHandler>;

const byRank = [{ field: "rank", direction: "asc" as const }];
const open = Predicate.eq("done", false);
/** The first two open todos: a window strictly smaller than the three it is cut from. */
const firstOpen = Subset.make({ collection: "todos", where: open, orderBy: byRank, limit: 2 });

const seededBackend = Effect.fnUntraced(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  yield* backend.applyMutations(
    { clientGroupId: "seed" },
    todos.map((todo, index) => ({
      clientId: "seed",
      mutationId: index + 1,
      mutator: "todo/set",
      args: todo,
      createdAt: 0,
    }))
  );
  return backend;
});

const makeServer = (
  backend: Backend,
  middleware?: Authorization.SyncMiddleware
): Effect.Effect<ServerHandler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const cvrStore = yield* Cvr.makeMemoryStore;
    const bus = yield* InvalidationBus.makeInProcess;
    const make = SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, cvrStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
    return yield* middleware === undefined
      ? make
      : make.pipe(Effect.provideService(Authorization.SyncMiddleware, middleware));
  });

const makeEngine = (handler: ServerHandler) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-a");
    return yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: Mutator.registry([]),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

describe("subscription totals on the pull (#210)", () => {
  it.effect("a pull reports each subscription's total, the collection's and not the window's", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer(yield* seededBackend());
      const all = Subset.make({ collection: "todos" });
      const response = yield* handler.handlePull({
        clientGroupId: "group-a",
        subscriptions: [firstOpen, all],
      });
      // The window holds two rows; its where matches three. The unwindowed one holds all five.
      expect(response.patch.filter(P.isTagged("Put"))).toHaveLength(5);
      expect(response.totals).toEqual([3, 5]);
    })
  );

  it.effect("a backend that cannot count sends no totals", () =>
    Effect.gen(function* () {
      const backend: Backend = { ...(yield* seededBackend()), evaluateCounted: undefined };
      const handler = yield* makeServer(backend);
      const response = yield* handler.handlePull({
        clientGroupId: "group-a",
        subscriptions: [firstOpen],
      });
      expect(response.totals).toBeUndefined();
    })
  );

  it.effect("no totals when the pull middleware changes the number of subscriptions", () =>
    Effect.gen(function* () {
      // The middleware adds a subscription the client never asked for, so the server's
      // list no longer lines up with the client's: no total can be placed, and none is sent.
      const middleware: Authorization.SyncMiddleware = {
        ...Authorization.passthroughMiddleware,
        onPull: (_context, request) =>
          Effect.succeed({
            ...request,
            subscriptions: [...request.subscriptions, Subset.make({ collection: "todos" })],
          }),
      };
      const handler = yield* makeServer(yield* seededBackend(), middleware);
      const response = yield* handler.handlePull({
        clientGroupId: "group-a",
        subscriptions: [firstOpen],
      });
      expect(response.totals).toBeUndefined();
    })
  );
});

describe("ClientEngine.totalOf (#210)", () => {
  it.effect("is undefined before a pull, then the last pull's total for the same filter", () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine(yield* makeServer(yield* seededBackend()));
      yield* engine.subscribe(firstOpen);
      expect(yield* engine.totalOf(firstOpen)).toBeUndefined();
      yield* engine.pull;
      expect(yield* engine.totalOf(firstOpen)).toBe(3);
      // Order, limit and cursor play no part: the same filter has the same total.
      expect(
        yield* engine.totalOf(
          Subset.make({
            collection: "todos",
            where: Predicate.and(open),
            orderBy: [{ field: "rank", direction: "desc" }],
            limit: 1,
            cursor: "t-4",
          })
        )
      ).toBe(3);
      // A different filter, or one no subscription has, has none.
      expect(
        yield* engine.totalOf(
          Subset.make({ collection: "todos", where: Predicate.eq("done", true) })
        )
      ).toBeUndefined();
    })
  );

  it.effect("follows the server: a write that changes the filter's rows moves the total", () =>
    Effect.gen(function* () {
      const backend = yield* seededBackend();
      const engine = yield* makeEngine(yield* makeServer(backend));
      yield* engine.subscribe(firstOpen);
      yield* engine.pull;
      expect(yield* engine.totalOf(firstOpen)).toBe(3);
      // Outside the window (rank 9 sorts past the first two), but inside the filter.
      yield* backend.applyMutations({ clientGroupId: "other" }, [
        {
          clientId: "other",
          mutationId: 1,
          mutator: "todo/set",
          args: { id: "t-9", done: false, rank: 9 },
          createdAt: 0,
        },
      ]);
      yield* engine.pull;
      expect(yield* engine.totalOf(firstOpen)).toBe(4);
    })
  );

  it.effect("an identity reset clears the totals with the subscriptions", () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine(yield* makeServer(yield* seededBackend()));
      yield* engine.reset("alice");
      yield* engine.subscribe(firstOpen);
      yield* engine.pull;
      expect(yield* engine.totalOf(firstOpen)).toBe(3);
      yield* engine.reset("bob");
      expect(yield* engine.totalOf(firstOpen)).toBeUndefined();
    })
  );
});
