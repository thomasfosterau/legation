/**
 * Hydration + seeding + prefetch (issue #41): `seed` renders confirmed rows
 * synchronously before any transport call and converges without a reset when
 * the versions are genuine; `dehydrate`/`hydrate` round-trip the store through
 * JSON; `ensureSubset` prefetches and dedupes concurrent pulls. Uses the same
 * MemoryBackend + SyncServer scaffolding as `engine.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Scope } from "effect";
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
import type { PatchOp, PullResponse } from "../Protocol.js";
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

  it.effect("a malformed snapshot fails as a StoreError", () =>
    Effect.gen(function* () {
      const target = yield* ClientStoreModule.makeMemory;
      const failure = yield* Effect.flip(
        Hydration.hydrate(target, { rows: "not-an-array" } as unknown as Hydration.Snapshot)
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
