/**
 * Hydration + seeding + prefetch (issue #41): `seed` renders confirmed rows
 * synchronously before any transport call and converges without a reset when
 * the versions are genuine; `dehydrate`/`hydrate` round-trip the store through
 * JSON; `ensureSubset` prefetches and dedupes concurrent pulls. Uses the same
 * MemoryBackend + SyncServer scaffolding as `engine.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as Hydration from "../Hydration.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import type { PatchOp, PullResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, ServerHandler } from "../Transport.js";

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

interface Recorder {
  readonly pulls: Ref.Ref<number>;
  readonly patches: Ref.Ref<ReadonlyArray<ReadonlyArray<PatchOp>>>;
}

/** A client bound to an explicit clientId + clientGroupId, with an optional pull recorder. */
const makeClient = (
  handler: ServerHandler,
  clientId: string,
  clientGroupId: string,
  recorder?: Recorder
) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const base = yield* makeInMemory(handler, clientGroupId);
    const transport: ClientTransport = {
      push: base.push,
      pull: (request) =>
        base
          .pull(request)
          .pipe(
            Effect.tap((response: PullResponse) =>
              recorder
                ? Ref.update(recorder.pulls, (n) => n + 1).pipe(
                    Effect.andThen(Ref.update(recorder.patches, (all) => [...all, response.patch]))
                  )
                : Effect.void
            )
          ),
      pokes: base.pokes,
      status: base.status,
      statusChanges: base.statusChanges,
    };
    const engine = yield* ClientEngineModule.make({
      clientId,
      clientGroupId,
      mutators: setTodo,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const allTodos = Subset.make({ collection: "todos" });

/** The node graph the `Query.Read`-shaped hydration APIs compile against. */
const testNodes = Node.registry([
  Node.make("todos", {
    attributes: { title: Schema.String, done: Schema.Boolean },
  }),
  Node.make("users", { attributes: {} }),
]);

describe("ClientEngine.seed (#41)", () => {
  it.effect(
    "renders seeded rows synchronously with no transport, then pull converges (no Clear)",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        // A real client establishes genuine confirmed rows + cookie in one group.
        const a = yield* makeClient(handler, "server", "group-shared");
        yield* a.engine.subscribe(allTodos);
        yield* a.engine.mutate("todo/set", { id: "1", title: "hydrated", done: false });
        yield* a.engine.push;
        yield* a.engine.pull;
        const snapshot = yield* Hydration.dehydrate(a.store);

        // A fresh client in the same group seeds those rows + continues the cookie.
        const recorder: Recorder = {
          pulls: yield* Ref.make(0),
          patches: yield* Ref.make<ReadonlyArray<ReadonlyArray<PatchOp>>>([]),
        };
        const b = yield* makeClient(handler, "browser", "group-shared", recorder);
        yield* b.engine.seed(
          snapshot.rows.map((row) => ({
            collection: row.collection,
            id: row.id,
            version: row.version,
            value: row.value,
          }))
        );
        if (snapshot.cookie !== undefined) yield* b.store.setCookie(snapshot.cookie);
        yield* b.engine.subscribe(allTodos);

        // Seeded rows are visible with no transport call.
        const seeded = yield* b.engine.query(allTodos);
        expect(seeded.map((row) => row.id)).toEqual(["1"]);
        expect(yield* Ref.get(recorder.pulls)).toBe(0);

        // A pull over the genuine cookie converges without a reset.
        yield* b.engine.pull;
        const patches = yield* Ref.get(recorder.patches);
        const ops = patches.flat();
        expect(ops.some((op) => op._tag === "Clear")).toBe(false);
        expect((yield* b.engine.query(allTodos)).map((row) => row.id)).toEqual(["1"]);
      })
  );
});

describe("Hydration.dehydrate/hydrate (#41)", () => {
  it.effect("round-trips rows + cookie + journal through JSON", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a", "group-a");
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "confirmed", done: false });
      yield* engine.push;
      yield* engine.pull;
      // A second, unpushed mutation stays in the journal.
      yield* engine.mutate("todo/set", { id: "2", title: "pending", done: false });

      const snapshot = yield* Hydration.dehydrate(store);
      const parsed = JSON.parse(JSON.stringify(snapshot)) as Hydration.Snapshot;

      const target = yield* ClientStoreModule.makeMemory;
      yield* Hydration.hydrate(target, parsed);

      expect(yield* target.listRows("todos")).toEqual(yield* store.listRows("todos"));
      expect(yield* target.getCookie).toEqual(yield* store.getCookie);
      expect(yield* target.pendingMutations).toEqual(yield* store.pendingMutations);
    })
  );

  it.effect(
    "a reused clientId resumes from its acked counter after the journal drained (#271)",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const a = yield* makeClient(handler, "a", "group-a");
        yield* a.engine.subscribe(allTodos);
        yield* a.engine.mutate("todo/set", { id: "1", title: "first", done: false });
        yield* a.engine.mutate("todo/set", { id: "2", title: "second", done: false });
        yield* a.engine.push;
        yield* a.engine.pull;
        // The acks drained the journal and the pull released the tail: no id survives but the counter.
        expect(yield* a.store.pendingMutations).toEqual([]);
        expect(yield* a.store.unpulled).toEqual([]);

        const snapshot = yield* Hydration.dehydrate(a.store);
        expect(snapshot.counters).toEqual({ a: 2 });
        const parsed = yield* Schema.decodeEffect(Hydration.SnapshotFromJson)(
          yield* Schema.encodeEffect(Hydration.SnapshotFromJson)(snapshot)
        );

        // The same clientId, hydrated into a fresh store, mutates and pushes.
        const store = yield* ClientStoreModule.makeMemory;
        yield* Hydration.hydrate(store, parsed);
        const engine = yield* ClientEngineModule.make({
          clientId: "a",
          clientGroupId: "group-a",
          mutators: setTodo,
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, yield* makeInMemory(handler, "group-a"))
        );
        yield* engine.mutate("todo/set", { id: "3", title: "after hydrate", done: false });
        expect((yield* store.pendingMutations).map((m) => m.mutationId)).toEqual([3]);
        yield* engine.push;

        // The backend applied it: another client sees the row.
        const reader = yield* makeClient(handler, "reader", "group-reader");
        yield* reader.engine.subscribe(allTodos);
        yield* reader.engine.pull;
        const ids = (yield* reader.engine.query(allTodos)).map((row) => row.id);
        expect(ids.toSorted()).toEqual(["1", "2", "3"]);
      })
  );

  it.effect("hydrate raises the counters and never lowers them (#271)", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      expect(yield* store.nextMutationId("a")).toBe(1);
      expect(yield* store.nextMutationId("a")).toBe(2);
      yield* Hydration.hydrate(store, { rows: [], journal: [], counters: { a: 1, b: 7 } });
      expect(yield* store.mutationCounters).toEqual({ a: 2, b: 7 });
      expect(yield* store.nextMutationId("a")).toBe(3);
      expect(yield* store.nextMutationId("b")).toBe(8);
    })
  );

  it.effect("a malformed snapshot fails as a StoreError", () =>
    Effect.gen(function* () {
      const target = yield* ClientStoreModule.makeMemory;
      // Untrusted input that merely claims to be a Snapshot: hydrate must validate it.
      const malformed: unknown = { rows: "not-an-array" };
      const failure = yield* Effect.flip(
        // oxlint-disable-next-line effect/no-widen-then-assert -- the test feeds hydrate a value that is deliberately not a Snapshot, to prove its runtime decode rejects it; no well-typed Snapshot can fail that decode
        Hydration.hydrate(target, malformed as Hydration.Snapshot)
      );
      expect(failure._tag).toBe("StoreError");
    })
  );
});

describe("ClientEngine.ensureSubset (#41)", () => {
  it.effect("prefetches a subset and dedupes concurrent calls into one pull", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      // Seed the backend with a row another client can prefetch.
      const writer = yield* makeClient(handler, "writer", "group-writer");
      yield* writer.engine.subscribe(allTodos);
      yield* writer.engine.mutate("todo/set", { id: "1", title: "remote", done: false });
      yield* writer.engine.push;

      const recorder: Recorder = {
        pulls: yield* Ref.make(0),
        patches: yield* Ref.make<ReadonlyArray<ReadonlyArray<PatchOp>>>([]),
      };
      const reader = yield* makeClient(handler, "reader", "group-reader", recorder);

      // Three concurrent prefetches of the same subset trigger at most one pull.
      yield* Effect.all(
        [
          reader.engine.ensureSubset(allTodos),
          reader.engine.ensureSubset(allTodos),
          reader.engine.ensureSubset(allTodos),
        ],
        { concurrency: "unbounded" }
      );
      expect(yield* Ref.get(recorder.pulls)).toBe(1);
      expect((yield* reader.engine.query(allTodos)).map((row) => row.id)).toEqual(["1"]);

      // Rows are already present, so a further call pulls nothing.
      yield* reader.engine.ensureSubset(allTodos);
      expect(yield* Ref.get(recorder.pulls)).toBe(1);
    })
  );
});

describe("Hydration.snapshot (SSR)", () => {
  it.effect(
    "produces rows + cookie over a request-scoped engine; the client continues without a reset",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        // Authoritative rows exist server-side, established by a writer client.
        const writer = yield* makeClient(handler, "writer", "group-writer");
        yield* writer.engine.subscribe(allTodos);
        yield* writer.engine.mutate("todo/set", { id: "1", title: "first", done: false });
        yield* writer.engine.push;

        // The SSR render: a request-scoped engine under the BROWSER's group id,
        // so the produced cookie continues that group's CVR conversation.
        const snapshot = yield* Hydration.snapshot({
          clientGroupId: "group-browser",
          nodes: testNodes,
          reads: [{ collection: "todos" }],
        }).pipe(Effect.provideService(ServerHandler, handler));

        expect(snapshot.rows.map((row) => row.id)).toEqual(["1"]);
        expect(snapshot.cookie).toBeDefined();
        expect(snapshot.journal).toEqual([]);

        // Browser boot: hydrate an empty durable store, build the engine over it.
        const recorder: Recorder = {
          pulls: yield* Ref.make(0),
          patches: yield* Ref.make<ReadonlyArray<ReadonlyArray<PatchOp>>>([]),
        };
        const browser = yield* makeClient(handler, "browser", "group-browser", recorder);
        expect(yield* Hydration.hydrateIfEmpty(browser.store, snapshot)).toBe(true);
        yield* browser.engine.subscribe(allTodos);

        // Snapshot rows render with no transport call.
        expect((yield* browser.engine.query(allTodos)).map((row) => row.id)).toEqual(["1"]);
        expect(yield* Ref.get(recorder.pulls)).toBe(0);

        // Meanwhile a new authoritative write lands server-side.
        yield* writer.engine.mutate("todo/set", { id: "2", title: "second", done: false });
        yield* writer.engine.push;

        // The first client pull continues from the carried cookie: no reset.
        yield* browser.engine.pull;
        const ops = (yield* Ref.get(recorder.patches)).flat();
        expect(ops.some((op) => op._tag === "Clear")).toBe(false);
        const ids = (yield* browser.engine.query(allTodos)).map((row) => row.id);
        expect(ids.toSorted()).toEqual(["1", "2"]);

        // A repeat boot must not regress the now-populated store.
        expect(yield* Hydration.hydrateIfEmpty(browser.store, snapshot)).toBe(false);
      })
  );
});

describe("Hydration.rowsFor", () => {
  const snapshot: Hydration.Snapshot = {
    rows: [
      { collection: "todos", id: "2", version: 1, value: { id: "2", title: "beta", done: false } },
      { collection: "todos", id: "1", version: 1, value: { id: "1", title: "alpha", done: true } },
      { collection: "todos", id: "3", version: 1, value: { id: "3", title: "gamma", done: false } },
      { collection: "users", id: "u1", version: 1, value: { id: "u1" } },
    ],
    journal: [],
  };

  it("filters snapshot rows by the read's collection and predicate", () => {
    const open = { collection: "todos", where: { done: false } };
    expect(Hydration.rowsFor(snapshot, testNodes, open).map((row) => row.id)).toEqual(["2", "3"]);
  });

  it("applies order and window like the engine's own evaluator", () => {
    const firstByTitle = { collection: "todos", order: ["title"], first: 1 };
    expect(Hydration.rowsFor(snapshot, testNodes, firstByTitle).map((row) => row.id)).toEqual([
      "1",
    ]);
  });
});
