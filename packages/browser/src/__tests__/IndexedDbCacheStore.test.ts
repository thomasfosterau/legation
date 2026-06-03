import { describe, expect, it } from "vitest";
import { Effect, Option, Scope } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { CacheStore, SyncKey } from "@thomasfosterau/effect-sync-core";
import type { CacheEntry } from "@thomasfosterau/effect-sync-core";
import * as IndexedDbCacheStore from "../IndexedDbCacheStore.js";

// Tests run in Node (no `window`), so the IndexedDB primitives come from
// fake-indexeddb, injected explicitly as the IndexedDb service.
const testIndexedDb = IndexedDb.make({ indexedDB, IDBKeyRange });

let dbCounter = 0;
// Each test gets its own database name so tests do not share persisted state.
const freshDb = (): string => `test-cache-${dbCounter++}`;

/** Run a scoped program with a store opened against `databaseName`. */
const withStore = <A, E>(
  databaseName: string,
  program: (store: CacheStore) => Effect.Effect<A, E, Scope.Scope>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(IndexedDbCacheStore.make({ databaseName, indexedDb: testIndexedDb }), program)
    ) as Effect.Effect<A, E>
  );

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
    const result = await withStore(freshDb(), (store) =>
      Effect.gen(function* () {
        const original = entry(["users", "1"], { name: "Ada" });
        yield* store.set(original);
        return yield* store.get(["users", "1"]);
      })
    );
    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrUndefined(result)).toEqual(entry(["users", "1"], { name: "Ada" }));
  });

  it("get on a missing key returns Option.none", async () => {
    const result = await withStore(freshDb(), (store) => store.get(["nope"]));
    expect(Option.isNone(result)).toBe(true);
  });

  it("remove returns true when present and false when absent", async () => {
    const result = await withStore(freshDb(), (store) =>
      Effect.gen(function* () {
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
    const result = await withStore(freshDb(), (store) =>
      Effect.gen(function* () {
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
    const result = await withStore(freshDb(), (store) =>
      Effect.gen(function* () {
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

  it("persists data across sessions against the same database name", async () => {
    const databaseName = freshDb();

    // First session: write an entry, then close the scope (and connection).
    await withStore(databaseName, (store) => store.set(entry(["users", "1"], { name: "Ada" })));

    // Second session over the same database sees the same data.
    const result = await withStore(databaseName, (store) => store.get(["users", "1"]));
    expect(Option.isSome(result)).toBe(true);
  });

  it("isolates data between different database names", async () => {
    const dbA = freshDb();
    const dbB = freshDb();

    await withStore(dbA, (store) => store.set(entry(["users", "1"], { name: "Ada" })));

    const result = await withStore(dbB, (store) =>
      Effect.gen(function* () {
        const fromB = yield* store.get(["users", "1"]);
        const sizeB = yield* store.size;
        return { fromB, sizeB };
      })
    );
    expect(Option.isNone(result.fromB)).toBe(true);
    expect(result.sizeB).toBe(0);
  });

  it("provides a CacheStore layer usable with Effect.provide", async () => {
    const databaseName = freshDb();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CacheStore;
        yield* store.set(entry(["layered"], "works"));
        return yield* store.get(["layered"]);
      }).pipe(
        Effect.provide(IndexedDbCacheStore.layer({ databaseName, indexedDb: testIndexedDb }))
      ) as Effect.Effect<Option.Option<CacheEntry>>
    );

    expect(Option.getOrUndefined(result)?.value).toBe("works");
  });
});
