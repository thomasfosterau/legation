/**
 * Per-row / per-mutation KeyValueStore layout (#47): confirmed rows live at
 * `row/{collection}/{id}` behind a `rowIndex/{collection}`, pending mutations at
 * `journal/{clientId}/{mutationId}` behind a compact `journalIndex`. This suite
 * covers the round-trip, the transparent legacy-blob migration, that
 * appendMutation/acknowledge never rewrite mutation bodies, preserved envelope
 * validation, and the journal high-water policy. The existing
 * `keyvalue-client-store` suite stays as-is.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import type { Mutation, PatchOp } from "../Protocol.js";

const mutation = (mutationId: number, clientId = "c1"): Mutation => ({
  clientId,
  mutationId,
  mutator: "noop",
  // A deliberately chunky body, so a rewrite would be expensive and visible.
  args: { blob: "x".repeat(1024), n: mutationId },
  createdAt: 0,
});

/** An in-memory KeyValueStore that counts `set` calls per key. */
const countingStore = () => {
  const data = new Map<string, string>();
  const sets = new Map<string, number>();
  const store = KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => data.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        sets.set(key, (sets.get(key) ?? 0) + 1);
        data.set(key, value);
      }),
    remove: (key) => Effect.sync(() => void data.delete(key)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { store, sets, data };
};

describe("ClientStore per-row layout (#47)", () => {
  it.effect("round-trips rows, journal, counters, and cookie, and rehydrates", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.putRow("todos", { id: "1", version: 1, value: { title: "persisted" } });
      yield* first.putRow("todos", { id: "2", version: 1, value: { title: "second" } });
      yield* first.putRow("notes", { id: "n1", version: 2, value: { body: "x" } });
      yield* first.appendMutation(mutation(yield* first.nextMutationId("c1")));
      yield* first.setCookie("cookie-1");
      yield* first.delRow("todos", "2");

      // A second store over the same KVS sees the split state.
      const second = yield* ClientStoreModule.makeKeyValue();
      expect((yield* second.getRow("todos", "1"))?.value).toEqual({ title: "persisted" });
      expect(yield* second.getRow("todos", "2")).toBeUndefined();
      expect(yield* second.listRows("todos")).toHaveLength(1);
      expect(yield* second.listRows("notes")).toHaveLength(1);
      expect(yield* second.pendingMutations).toHaveLength(1);
      expect(yield* second.getCookie).toBe("cookie-1");
      expect(yield* second.nextMutationId("c1")).toBe(2);

      // A batched applyRowOps round-trips through the index too.
      yield* second.applyRowOps([
        { _tag: "Put", collection: "todos", id: "3", version: 1, value: { title: "batched" } },
        { _tag: "Del", collection: "todos", id: "1" },
      ]);
      const third = yield* ClientStoreModule.makeKeyValue();
      expect((yield* third.listRows("todos")).map((r) => r.id)).toEqual(["3"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("applyRowOps honours a Clear before the surviving ops", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.putRow("todos", { id: "old", version: 1, value: {} });
      yield* store.applyRowOps([
        { _tag: "Clear" },
        { _tag: "Put", collection: "todos", id: "fresh", version: 1, value: {} },
      ]);
      expect((yield* store.listRows("todos")).map((r) => r.id)).toEqual(["fresh"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("migrates a populated legacy (layout 1) blob store on first open", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      // Pre-populate the legacy whole-blob layout directly (no `__layout` key).
      yield* kv.set("legation/collections", JSON.stringify(["todos", "notes"]));
      yield* kv.set(
        "legation/rows/todos",
        JSON.stringify({ "1": { id: "1", version: 1, value: { title: "a" } } })
      );
      yield* kv.set(
        "legation/rows/notes",
        JSON.stringify({ n1: { id: "n1", version: 2, value: { body: "x" } } })
      );
      yield* kv.set(
        "legation/journal",
        JSON.stringify([
          { clientId: "c1", mutationId: 1, mutator: "noop", args: { a: 1 }, createdAt: 0 },
        ])
      );
      yield* kv.set("legation/counters", JSON.stringify({ c1: 1 }));
      yield* kv.set("legation/cookie", "cookie-legacy");

      const store = yield* ClientStoreModule.makeKeyValue();
      // Everything reads back through the new per-row / per-mutation keys.
      expect((yield* store.getRow("todos", "1"))?.value).toEqual({ title: "a" });
      expect(yield* store.listRows("notes")).toHaveLength(1);
      expect(yield* store.pendingMutations).toHaveLength(1);
      expect(yield* store.getCookie).toBe("cookie-legacy");
      expect(yield* store.nextMutationId("c1")).toBe(2);
      // The layout is stamped and the legacy blobs are gone.
      expect(yield* kv.get("legation/__layout")).toBe("2");
      expect(yield* kv.get("legation/rows/todos")).toBeUndefined();
      expect(yield* kv.get("legation/journal")).toBeUndefined();
      expect(yield* kv.get("legation/row/todos/1")).toBeDefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("appendMutation and acknowledge never rewrite mutation bodies", () =>
    Effect.gen(function* () {
      const { store, sets } = countingStore();
      yield* Effect.gen(function* () {
        const s = yield* ClientStoreModule.makeKeyValue();
        yield* s.appendMutation(mutation(1));
        yield* s.appendMutation(mutation(2));
        // Each large body is written exactly once.
        expect(sets.get("legation/journal/c1/1")).toBe(1);
        expect(sets.get("legation/journal/c1/2")).toBe(1);

        // Acknowledging #1 removes its body and rewrites only the tiny index —
        // the surviving body #2 is never touched again.
        yield* s.acknowledge("c1", 1);
        expect(sets.get("legation/journal/c1/2")).toBe(1);
        expect(yield* s.pendingMutations).toHaveLength(1);
      }).pipe(Effect.provideService(KeyValueStore.KeyValueStore, store));
    })
  );

  it.effect("dropPending (#117) never rewrites surviving mutation bodies", () =>
    Effect.gen(function* () {
      const { store, sets } = countingStore();
      yield* Effect.gen(function* () {
        const s = yield* ClientStoreModule.makeKeyValue();
        yield* s.appendMutation(mutation(1));
        yield* s.appendMutation(mutation(2));
        yield* s.appendMutation(mutation(3));

        // Dropping the superseded #1 (paced coalescing) removes only its body
        // and rewrites the tiny index — #2 and #3's bodies are untouched.
        yield* s.dropPending("c1", [1]);
        expect(sets.get("legation/journal/c1/2")).toBe(1);
        expect(sets.get("legation/journal/c1/3")).toBe(1);
        expect((yield* s.pendingMutations).map((m) => m.mutationId)).toEqual([2, 3]);
      }).pipe(Effect.provideService(KeyValueStore.KeyValueStore, store));
    })
  );

  it.effect("a K-op patch writes ~K row values, independent of collection size", () =>
    Effect.gen(function* () {
      const { store, sets } = countingStore();
      yield* Effect.gen(function* () {
        const s = yield* ClientStoreModule.makeKeyValue();
        // A large confirmed collection.
        const seed: Array<PatchOp> = Array.from({ length: 500 }, (_, i) => ({
          _tag: "Put" as const,
          collection: "todos",
          id: `r${i}`,
          version: 1,
          value: { i },
        }));
        yield* s.applyRowOps(seed);
        sets.clear();

        // A 3-op patch over the 500-row collection.
        yield* s.applyRowOps([
          { _tag: "Put", collection: "todos", id: "r0", version: 2, value: { i: 0 } },
          { _tag: "Put", collection: "todos", id: "r1", version: 2, value: { i: 1 } },
          { _tag: "Del", collection: "todos", id: "r2" },
        ]);
        // 2 row-value writes for the puts (dels remove, not set), plus the
        // single index rewrite and the collections track — a small constant,
        // not the 500-row collection re-serialised per op.
        const rowValueWrites = [...sets.keys()].filter((k) =>
          k.startsWith("legation/row/todos/")
        ).length;
        expect(rowValueWrites).toBe(2);
        expect(sets.get("legation/rowIndex/todos")).toBe(1);
      }).pipe(Effect.provideService(KeyValueStore.KeyValueStore, store));
    })
  );

  it.effect("a corrupt persisted row fails as a StoreError, not a silent cast", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.putRow("todos", { id: "1", version: 1, value: {} });

      // Corrupt the per-row value directly; the index still points at it.
      yield* kv.set("legation/row/todos/1", "}{ not json");
      const listError = yield* Effect.flip(store.listRows("todos"));
      expect(listError._tag).toBe("StoreError");
      const getError = yield* Effect.flip(store.getRow("todos", "1"));
      expect(getError._tag).toBe("StoreError");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("journal high-water refuses the append rather than dropping the intent", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 2 });
      yield* store.appendMutation(mutation(1));
      yield* store.appendMutation(mutation(2));
      const error = yield* Effect.flip(store.appendMutation(mutation(3)));
      expect(error._tag).toBe("StoreError");
      expect(error.message).toContain("high-water");
      // The intent was refused, not silently dropped: still exactly two pending.
      expect(yield* store.pendingMutations).toHaveLength(2);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("journal high-water surfaces through the engine's mutate", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(
            Mutator.make("todo/set", Schema.Struct({ id: Schema.String })),
            (args, writer) => writer.put("todos", args.id, args)
          ),
        ])
      );
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );

      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 1 });
      const transport = yield* makeInMemory(handler, "group-hw");
      const engine = yield* ClientEngineModule.make({
        clientId: "client-hw",
        clientGroupId: "group-hw",
        mutators: Mutator.registry([
          {
            mutator: Mutator.make("todo/set", Schema.Struct({ id: Schema.String })),
            local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
          },
        ]),
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      yield* engine.mutate("todo/set", { id: "1" });
      const error = yield* Effect.flip(engine.mutate("todo/set", { id: "2" }));
      expect(error._tag).toBe("StoreError");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});
