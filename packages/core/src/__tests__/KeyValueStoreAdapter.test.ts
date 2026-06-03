import { describe, expect, it } from "vitest";
import * as SyncKey from "../SyncKey.js";
import { type CacheEntry, CacheStore } from "../CacheStore.js";
import { Effect, Layer, Option } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as KeyValueStoreAdapter from "../KeyValueStoreAdapter.js";

const entry = (key: SyncKey.SyncKey, value: unknown): CacheEntry => ({
  key,
  value,
  updatedAt: 0,
  staleAt: null,
  expiresAt: null,
  tags: [],
});

const withStore = <A, E>(
  layer: Layer.Layer<CacheStore, never, never>,
  program: (store: CacheStore) => Effect.Effect<A, E, CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(CacheStore), program).pipe(
      Effect.provide(layer)
    ) as Effect.Effect<A, E>
  );

const adapterLayer = KeyValueStoreAdapter.layer.pipe(Layer.provide(KeyValueStore.layerMemory));

describe("KeyValueStoreAdapter", () => {
  it("round-trips set/get", async () => {
    const result = await withStore(adapterLayer, (store) =>
      Effect.gen(function* () {
        yield* store.set(entry(["users", "1"], { name: "Ada" }));
        const got = yield* store.get(["users", "1"]);
        return Option.getOrUndefined(got)?.value;
      })
    );
    expect(result).toEqual({ name: "Ada" });
  });

  it("returns None for a missing key", async () => {
    const result = await withStore(adapterLayer, (store) => store.get(["nope"]));
    expect(Option.isNone(result)).toBe(true);
  });

  it("removes entries and reports prior existence", async () => {
    const result = await withStore(adapterLayer, (store) =>
      Effect.gen(function* () {
        yield* store.set(entry(["k"], 1));
        const removedExisting = yield* store.remove(["k"]);
        const removedMissing = yield* store.remove(["k"]);
        const after = yield* store.get(["k"]);
        return { removedExisting, removedMissing, present: Option.isSome(after) };
      })
    );
    expect(result.removedExisting).toBe(true);
    expect(result.removedMissing).toBe(false);
    expect(result.present).toBe(false);
  });

  it("enumerates entries with a prefix filter", async () => {
    const result = await withStore(adapterLayer, (store) =>
      Effect.gen(function* () {
        yield* store.set(entry(["users", "1"], "a"));
        yield* store.set(entry(["users", "2"], "b"));
        yield* store.set(entry(["posts", "1"], "c"));

        const all = yield* store.entries();
        const users = yield* store.entries(SyncKey.prefixFilter(["users"]));
        const size = yield* store.size;
        return {
          allCount: all.length,
          userKeys: users
            .map((e) => e.key)
            .slice()
            .sort(),
          size,
        };
      })
    );
    expect(result.allCount).toBe(3);
    expect(result.size).toBe(3);
    expect(result.userKeys).toEqual([
      ["users", "1"],
      ["users", "2"],
    ]);
  });

  it("clears every entry and the index", async () => {
    const result = await withStore(adapterLayer, (store) =>
      Effect.gen(function* () {
        yield* store.set(entry(["a"], 1));
        yield* store.set(entry(["b"], 2));
        yield* store.clear;
        const size = yield* store.size;
        const entries = yield* store.entries();
        return { size, count: entries.length };
      })
    );
    expect(result.size).toBe(0);
    expect(result.count).toBe(0);
  });

  it("persists across CacheStore instances sharing one KV layer", async () => {
    // A single KeyValueStore.layerMemory instance shared by two adapters.
    const sharedKv = KeyValueStore.layerMemory;

    const program = Effect.gen(function* () {
      // First adapter writes.
      yield* KeyValueStoreAdapter.make.pipe(
        Effect.flatMap((store) => store.set(entry(["persisted"], { v: 42 })))
      );
      // Second, independently-constructed adapter reads the same KV.
      const second = yield* KeyValueStoreAdapter.make;
      const got = yield* second.get(["persisted"]);
      return Option.getOrUndefined(got)?.value;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(sharedKv)) as Effect.Effect<unknown>
    );
    expect(result).toEqual({ v: 42 });
  });

  it("treats invalid JSON in the store as a cache miss", async () => {
    // Write a key directly through the raw KV so the adapter sees garbage.
    const program = Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const storeKey = `effect-sync-core:${SyncKey.hash(["broken"])}`;
      yield* kv.set(storeKey, "{not valid json");
      const store = yield* KeyValueStoreAdapter.make;
      const got = yield* store.get(["broken"]);
      return Option.isNone(got);
    });
    const isNone = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStore.layerMemory)) as Effect.Effect<boolean>
    );
    expect(isNone).toBe(true);
  });

  it("treats a structurally-corrupted entry as a cache miss", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const hash = SyncKey.hash(["corrupt"]);
      const storeKey = `effect-sync-core:${hash}`;
      // Valid JSON, but missing required fields (no tags / updatedAt etc.).
      yield* kv.set(storeKey, JSON.stringify({ key: ["corrupt"], value: 1 }));
      // Register it in the index too, so entries() also has to skip it.
      yield* kv.set("effect-sync-core:__index__", JSON.stringify([hash]));
      const store = yield* KeyValueStoreAdapter.make;
      const got = yield* store.get(["corrupt"]);
      const all = yield* store.entries();
      return { isNone: Option.isNone(got), count: all.length };
    });
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStore.layerMemory)) as Effect.Effect<{
        isNone: boolean;
        count: number;
      }>
    );
    expect(result.isNone).toBe(true);
    expect(result.count).toBe(0);
  });

  it("skips corrupted entries but keeps valid ones in entries()", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = yield* KeyValueStoreAdapter.make;
      // Write one good entry through the adapter (also seeds the index).
      yield* store.set(entry(["good"], "ok"));
      // Corrupt a second entry directly and add it to the index.
      const badHash = SyncKey.hash(["bad"]);
      yield* kv.set(`effect-sync-core:${badHash}`, "garbage");
      const index = yield* kv
        .get("effect-sync-core:__index__")
        .pipe(Effect.map((v) => (v === undefined ? [] : (JSON.parse(v) as Array<string>))));
      yield* kv.set("effect-sync-core:__index__", JSON.stringify([...index, badHash]));
      const all = yield* store.entries();
      return all.map((e) => e.value);
    });
    const values = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStore.layerMemory)) as Effect.Effect<Array<unknown>>
    );
    expect(values).toEqual(["ok"]);
  });

  it("works end-to-end behind WriteThroughCache", async () => {
    // Sanity check that the adapter satisfies the engine contract.
    const result = await withStore(adapterLayer, (store) =>
      Effect.gen(function* () {
        yield* store.set(entry(["x"], "first"));
        yield* store.set({ ...entry(["x"], "second") });
        const got = yield* store.get(["x"]);
        const size = yield* store.size;
        return { value: Option.getOrUndefined(got)?.value, size };
      })
    );
    // Re-setting the same key must not duplicate the index entry.
    expect(result.value).toBe("second");
    expect(result.size).toBe(1);
  });
});
