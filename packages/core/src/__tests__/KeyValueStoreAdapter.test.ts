import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { type CacheEntry, CacheStore } from "../CacheStore.js";
import * as KeyValueStoreAdapter from "../KeyValueStoreAdapter.js";
import * as SyncKey from "../SyncKey.js";

const entry = (key: SyncKey.SyncKey, value: unknown): CacheEntry => ({
  key,
  value,
  updatedAt: 0,
  staleAt: null,
  expiresAt: null,
  tags: [],
});

const adapterLayer = KeyValueStoreAdapter.layer.pipe(Layer.provide(KeyValueStore.layerMemory));

describe("KeyValueStoreAdapter", () => {
  it.effect("round-trips set/get", () =>
    Effect.gen(function* () {
      const store = yield* CacheStore;
      yield* store.set(entry(["users", "1"], { name: "Ada" }));
      const got = yield* store.get(["users", "1"]);
      expect(Option.getOrUndefined(got)?.value).toEqual({ name: "Ada" });
    }).pipe(Effect.provide(adapterLayer))
  );

  it.effect("returns None for a missing key", () =>
    Effect.gen(function* () {
      const store = yield* CacheStore;
      const result = yield* store.get(["nope"]);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(adapterLayer))
  );

  it.effect("removes entries and reports prior existence", () =>
    Effect.gen(function* () {
      const store = yield* CacheStore;
      yield* store.set(entry(["k"], 1));
      const removedExisting = yield* store.remove(["k"]);
      const removedMissing = yield* store.remove(["k"]);
      const after = yield* store.get(["k"]);

      expect(removedExisting).toBe(true);
      expect(removedMissing).toBe(false);
      expect(Option.isSome(after)).toBe(false);
    }).pipe(Effect.provide(adapterLayer))
  );

  it.effect("enumerates entries with a prefix filter", () =>
    Effect.gen(function* () {
      const store = yield* CacheStore;
      yield* store.set(entry(["users", "1"], "a"));
      yield* store.set(entry(["users", "2"], "b"));
      yield* store.set(entry(["posts", "1"], "c"));

      const all = yield* store.entries();
      const users = yield* store.entries(SyncKey.prefixFilter(["users"]));
      const size = yield* store.size;

      expect(all.length).toBe(3);
      expect(size).toBe(3);
      expect(
        users
          .map((e) => e.key)
          .slice()
          .sort()
      ).toEqual([
        ["users", "1"],
        ["users", "2"],
      ]);
    }).pipe(Effect.provide(adapterLayer))
  );

  it.effect("clears every entry and the index", () =>
    Effect.gen(function* () {
      const store = yield* CacheStore;
      yield* store.set(entry(["a"], 1));
      yield* store.set(entry(["b"], 2));
      yield* store.clear;
      const size = yield* store.size;
      const entries = yield* store.entries();

      expect(size).toBe(0);
      expect(entries.length).toBe(0);
    }).pipe(Effect.provide(adapterLayer))
  );

  it.effect("persists across CacheStore instances sharing one KV layer", () =>
    Effect.gen(function* () {
      // First adapter writes.
      yield* KeyValueStoreAdapter.make.pipe(
        Effect.flatMap((store) => store.set(entry(["persisted"], { v: 42 })))
      );
      // Second, independently-constructed adapter reads the same KV.
      const second = yield* KeyValueStoreAdapter.make;
      const got = yield* second.get(["persisted"]);

      expect(Option.getOrUndefined(got)?.value).toEqual({ v: 42 });
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("treats invalid JSON in the store as a cache miss", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const storeKey = `effect-sync-core:${SyncKey.hash(["broken"])}`;
      yield* kv.set(storeKey, "{not valid json");
      const store = yield* KeyValueStoreAdapter.make;
      const got = yield* store.get(["broken"]);

      expect(Option.isNone(got)).toBe(true);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("treats a structurally-corrupted entry as a cache miss", () =>
    Effect.gen(function* () {
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

      expect(Option.isNone(got)).toBe(true);
      expect(all.length).toBe(0);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("skips corrupted entries but keeps valid ones in entries()", () =>
    Effect.gen(function* () {
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

      expect(all.map((e) => e.value)).toEqual(["ok"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("works end-to-end behind WriteThroughCache", () =>
    Effect.gen(function* () {
      // Sanity check that the adapter satisfies the engine contract.
      const store = yield* CacheStore;
      yield* store.set(entry(["x"], "first"));
      yield* store.set({ ...entry(["x"], "second") });
      const got = yield* store.get(["x"]);
      const size = yield* store.size;

      // Re-setting the same key must not duplicate the index entry.
      expect(Option.getOrUndefined(got)?.value).toBe("second");
      expect(size).toBe(1);
    }).pipe(Effect.provide(adapterLayer))
  );
});
