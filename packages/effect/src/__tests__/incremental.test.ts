/**
 * Selective live-query re-evaluation: a change event names the collections it
 * touched, so an observer of one collection does not re-evaluate when a
 * different collection changes. A read-only client (empty journal) pulls
 * collection-scoped changes; we count emissions per query.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const put =
  (collection: string): MemoryBackend.BackendHandler =>
  (args, writer) =>
    Effect.asVoid(writer.put(collection, (args as { id: string }).id, args));

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": put("todos"),
  "user/set": put("users"),
};
const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (a, w) => w.put("todos", (a as { id: string }).id, a),
  },
  {
    mutator: Mutator.make("user/set", Schema.Unknown),
    local: (a, w) => w.put("users", (a as { id: string }).id, a),
  },
]);

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll, users: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (handler: ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, group);
    return yield* ClientEngineModule.make({ clientId: group, clientGroupId: group, mutators }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const todos = Subset.make({ collection: "todos" });
const users = Subset.make({ collection: "users" });
const settle = Effect.sleep(Duration.millis(50));

describe("selective live-query re-evaluation", () => {
  it("re-evaluates a query only when its collection changes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");

        yield* writer.mutate("user/set", { id: "u1", name: "a" });
        yield* writer.mutate("todo/set", { id: "t1", title: "x" });
        yield* writer.push;
        yield* reader.subscribe(todos);
        yield* reader.subscribe(users);
        yield* reader.pull;

        const todosCount = yield* Ref.make(0);
        const usersCount = yield* Ref.make(0);
        yield* Effect.forkScoped(
          Stream.runForEach(reader.observe(todos), () => Ref.update(todosCount, (n) => n + 1))
        );
        yield* Effect.forkScoped(
          Stream.runForEach(reader.observe(users), () => Ref.update(usersCount, (n) => n + 1))
        );
        yield* settle;
        expect(yield* Ref.get(todosCount)).toBe(1); // initial
        expect(yield* Ref.get(usersCount)).toBe(1);

        // A todos-only change: the reader's pull patches only `todos`.
        yield* writer.mutate("todo/set", { id: "t2", title: "y" });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;
        expect(yield* Ref.get(todosCount)).toBe(2); // re-evaluated
        expect(yield* Ref.get(usersCount)).toBe(1); // skipped — different collection

        // A users-only change re-evaluates the users query (and not todos).
        yield* writer.mutate("user/set", { id: "u2", name: "b" });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;
        expect(yield* Ref.get(usersCount)).toBe(2);
        expect(yield* Ref.get(todosCount)).toBe(2);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("maintains a paginated live query incrementally", async () => {
    const top2 = Subset.make({
      collection: "todos",
      orderBy: [{ field: "rank", direction: "asc" }],
      limit: 2,
    });
    const page = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id);

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");

        yield* writer.mutate("todo/set", { id: "t1", rank: 1 });
        yield* writer.mutate("todo/set", { id: "t3", rank: 3 });
        yield* writer.push;
        yield* reader.subscribe(top2);
        yield* reader.pull;

        const pages = yield* Ref.make<Array<ReadonlyArray<string>>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(reader.observe(top2), (rows) =>
            Ref.update(pages, (acc) => [...acc, page(rows)])
          )
        );
        yield* settle;

        // A row that sorts into the page pushes the last visible row out.
        yield* writer.mutate("todo/set", { id: "t2", rank: 2 });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;

        // A row beyond the limit does not move the page → no re-emit.
        yield* writer.mutate("todo/set", { id: "t4", rank: 4 });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;

        expect(yield* Ref.get(pages)).toEqual([
          ["t1", "t3"],
          ["t1", "t2"],
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);
});
