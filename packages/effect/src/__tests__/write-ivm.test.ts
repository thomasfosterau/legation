/**
 * Write-path incremental view maintenance (#39): a `mutate` and a push
 * acknowledgement carry the collections they touch, so an observer of a
 * different collection neither re-emits nor re-materializes. A shared overlay
 * cache means one change costs one replay, not one per observer. Plus the
 * LiveView id index (O(1) absent-id no-op, binary-search locate).
 *
 * Observer fibers drain the changes PubSub asynchronously, so these use
 * `it.live` (real clock) with a short settle, mirroring `incremental.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as LiveView from "../LiveView.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const put =
  (collection: string): MemoryBackend.BackendHandler =>
  (args, writer) =>
    Effect.asVoid(writer.put(collection, (args as { id: string }).id, args));

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
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
  const backend = yield* MemoryBackend.make(backendHandlers);
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

// A client whose `listRows` calls are counted, so a test can prove the overlay
// materializes once (one replay) rather than once per observer.
const makeClient = (handler: ServerHandler, group: string) =>
  Effect.gen(function* () {
    const base = yield* ClientStoreModule.makeMemory;
    const listRowsCount = yield* Ref.make(0);
    const store: ClientStore = {
      ...base,
      listRows: (collection) =>
        Ref.update(listRowsCount, (n) => n + 1).pipe(Effect.andThen(base.listRows(collection))),
    };
    const transport = yield* makeInMemory(handler, group);
    const engine = yield* ClientEngineModule.make({
      clientId: group,
      clientGroupId: group,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, listRowsCount };
  });

const todos = Subset.make({ collection: "todos" });
const users = Subset.make({ collection: "users" });
const settle = Effect.sleep(Duration.millis(50));

const observeInto = (
  engine: ClientEngineModule.ClientEngine,
  subset: Subset.Subset,
  counter: Ref.Ref<number>
) =>
  Effect.forkScoped(
    Stream.runForEach(engine.observe(subset), () => Ref.update(counter, (n) => n + 1))
  );

describe("write-path selective re-evaluation", () => {
  it.live("a mutate does not re-emit an observer of an untouched collection", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeClient(yield* makeServer, "w");
      const todosCount = yield* Ref.make(0);
      const usersCount = yield* Ref.make(0);
      yield* observeInto(engine, todos, todosCount);
      yield* observeInto(engine, users, usersCount);
      yield* settle;
      expect(yield* Ref.get(todosCount)).toBe(1); // initial page
      expect(yield* Ref.get(usersCount)).toBe(1);

      yield* engine.mutate("todo/set", { id: "t1", title: "x" });
      yield* settle;
      expect(yield* Ref.get(todosCount)).toBe(2); // optimistic row appeared
      expect(yield* Ref.get(usersCount)).toBe(1); // untouched collection: no re-emit
    })
  );

  it.live("a push acknowledgement does not rebuild an observer of an untouched collection", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeClient(yield* makeServer, "w");
      const todosCount = yield* Ref.make(0);
      const usersCount = yield* Ref.make(0);
      yield* observeInto(engine, todos, todosCount);
      yield* observeInto(engine, users, usersCount);
      yield* settle;
      const usersBefore = yield* Ref.get(usersCount);

      yield* engine.mutate("todo/set", { id: "t1", title: "x" });
      yield* engine.push; // acknowledges + trims the todos mutation
      yield* settle;
      expect(yield* Ref.get(usersCount)).toBe(usersBefore); // untouched by mutate or ack
      expect(yield* Ref.get(todosCount)).toBeGreaterThan(1); // todos did move
    })
  );

  it.live("a single mutate materializes the overlay once for N observers", () =>
    Effect.gen(function* () {
      const { engine, listRowsCount } = yield* makeClient(yield* makeServer, "w");
      yield* Effect.forEach(Array.from({ length: 5 }), () =>
        Effect.forkScoped(Stream.runForEach(engine.observe(todos), () => Effect.void))
      );
      yield* settle;
      yield* Ref.set(listRowsCount, 0); // measure only the mutate-triggered replay

      yield* engine.mutate("todo/set", { id: "t1", title: "x" });
      yield* settle;
      // Cached + single-flight: one replay seeds `todos` once, not once per observer.
      expect(yield* Ref.get(listRowsCount)).toBe(1);
    })
  );
});

describe("LiveView id index", () => {
  const ranked = Subset.make({
    collection: "items",
    orderBy: [{ field: "rank", direction: "asc" }],
  });
  const row = (id: string, rank: number): LiveView.Row => ({ id, value: { rank } });
  const ids = (rows: ReadonlyArray<LiveView.Row>) => rows.map((r) => r.id);

  it("locates and repositions rows via the id index (distinct sort keys)", () => {
    let view = LiveView.make(ranked, [row("a", 1), row("b", 2), row("c", 3)]);
    view = LiveView.put(view, row("b", 5)); // reposition b to the end
    expect(ids(LiveView.result(view))).toEqual(["a", "c", "b"]);
    view = LiveView.del(view, "a");
    expect(ids(LiveView.result(view))).toEqual(["c", "b"]);
    expect(LiveView.del(view, "missing")).toBe(view); // absent id: O(1) no-op, same ref
  });

  it("scans the equal-key run to locate an id on a shared sort key", () => {
    let view = LiveView.make(ranked, [row("a", 1), row("b", 1), row("c", 1)]);
    view = LiveView.del(view, "b"); // b ties with a and c on rank 1
    expect(ids(LiveView.result(view)).toSorted()).toEqual(["a", "c"]);
    view = LiveView.put(view, row("a", 1)); // update within the tie run
    expect(ids(LiveView.result(view)).toSorted()).toEqual(["a", "c"]);
  });
});
