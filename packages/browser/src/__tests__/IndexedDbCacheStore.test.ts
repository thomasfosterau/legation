import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { SyncKey } from "@thomasfosterau/effect-sync-core";
import type { CacheEntry } from "@thomasfosterau/effect-sync-core";
import * as IndexedDbCacheStore from "../IndexedDbCacheStore.js";

let dbCounter = 0;
// Each test gets its own database name so tests do not share persisted state.
const freshDb = (): string => `test-cache-${dbCounter++}`;

const entry = (key: SyncKey.SyncKey, value: unknown): CacheEntry => ({
  key,
  value,
  updatedAt: 1000,
  staleAt: 2000,
  expiresAt: 3000,
  version: 1,
  tags: ["t1"],
});

describe("IndexedDbCacheStore", () => {
  it("set/get roundtrip preserves the CacheEntry structure", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexedDbCacheStore.make({ databaseName });
        const original = entry(["users", "1"], { name: "Ada" });
        yield* store.set(original);
        return yield* store.get(["users", "1"]);
      })
    );
    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrUndefined(result)).toEqual(entry(["users", "1"], { name: "Ada" }));
  });

  it("get on a missing key returns Option.none", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexedDbCacheStore.make({ databaseName });
        return yield* store.get(["nope"]);
      })
    );
    expect(Option.isNone(result)).toBe(true);
  });

  it("remove returns true when present and false when absent", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexedDbCacheStore.make({ databaseName });
        yield* store.set(entry(["users", "1"], { name: "Ada" }));
        const removedPresent = yield* store.remove(["users", "1"]);
        const removedAbsent = yield* store.remove(["users", "1"]);
        return { removedPresent, removedAbsent };
      })
    );
    expect(result.removedPresent).toBe(true);
    expect(result.removedAbsent).toBe(false);
  });

  it("entries() filters by a prefix KeyFilter", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexedDbCacheStore.make({ databaseName });
        yield* store.set(entry(["users", "1"], { name: "Ada" }));
        yield* store.set(entry(["users", "2"], { name: "Bob" }));
        yield* store.set(entry(["posts", "1"], { title: "Hi" }));
        return yield* store.entries(SyncKey.prefixFilter(["users"]));
      })
    );
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.key[0] === "users")).toBe(true);
  });

  it("clear empties the store and size reflects counts", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexedDbCacheStore.make({ databaseName });
        yield* store.set(entry(["a"], 1));
        yield* store.set(entry(["b"], 2));
        const sizeBefore = yield* store.size;
        yield* store.clear;
        const sizeAfter = yield* store.size;
        return { sizeBefore, sizeAfter };
      })
    );
    expect(result.sizeBefore).toBe(2);
    expect(result.sizeAfter).toBe(0);
  });

  it("persists data across make() calls against the same database name", async () => {
    const databaseName = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* IndexedDbCacheStore.make({ databaseName });
        yield* first.set(entry(["users", "1"], { name: "Ada" }));

        // A fresh store handle over the same database sees the same data.
        const second = yield* IndexedDbCacheStore.make({ databaseName });
        return yield* second.get(["users", "1"]);
      })
    );
    expect(Option.isSome(result)).toBe(true);
  });

  it("isolates data between different database names", async () => {
    const dbA = freshDb();
    const dbB = freshDb();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* IndexedDbCacheStore.make({ databaseName: dbA });
        yield* a.set(entry(["users", "1"], { name: "Ada" }));

        const b = yield* IndexedDbCacheStore.make({ databaseName: dbB });
        const fromB = yield* b.get(["users", "1"]);
        const sizeB = yield* b.size;
        return { fromB, sizeB };
      })
    );
    expect(Option.isNone(result.fromB)).toBe(true);
    expect(result.sizeB).toBe(0);
  });
});
