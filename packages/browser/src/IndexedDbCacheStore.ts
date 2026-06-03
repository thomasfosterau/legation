/**
 * IndexedDbCacheStore
 *
 * A `CacheStore` (from `@thomasfosterau/effect-sync-core`) backed by the
 * browser's `indexedDB`. Cache entries survive page reloads, so this is the
 * persistence layer for an offline-first client cache.
 *
 * Records are stored as `{ keyHash, entry }` in a single object store keyed
 * by `keyHash` (the deterministic `SyncKey.hash` of the entry's key). Cache
 * values must be structured-cloneable; the sync engine's values are plain
 * JSON-ish data, so this holds in practice.
 *
 * All `IDBRequest`s are bridged into Effect and every failure is mapped to a
 * `StoreError` carrying the original cause.
 */

import { Effect, Layer, Option } from "effect";
import { CacheStore, StoreError, SyncKey } from "@thomasfosterau/effect-sync-core";
import type { CacheEntry } from "@thomasfosterau/effect-sync-core";

type KeyFilter = SyncKey.KeyFilter;

/**
 * Options for {@link make} / {@link layer}.
 */
export interface IndexedDbCacheStoreOptions {
  /** Database name. Default: `"effect-sync-cache"`. */
  readonly databaseName?: string | undefined;
  /** Object store name. Default: `"entries"`. */
  readonly storeName?: string | undefined;
}

const DEFAULT_DB = "effect-sync-cache";
const DEFAULT_STORE = "entries";

/** A persisted record. */
interface StoredRecord {
  readonly keyHash: string;
  readonly entry: CacheEntry;
}

/**
 * Construct an IndexedDB-backed `CacheStore`.
 *
 * Opening the database (and creating the object store on first use) happens
 * eagerly when this effect runs; subsequent `make` calls against the same
 * `databaseName` see the same persisted data.
 */
export const make = (options?: IndexedDbCacheStoreOptions): Effect.Effect<CacheStore, StoreError> =>
  Effect.gen(function* () {
    const databaseName = options?.databaseName ?? DEFAULT_DB;
    const storeName = options?.storeName ?? DEFAULT_STORE;

    const db = yield* Effect.callback<IDBDatabase, StoreError>((resume) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(databaseName);
      } catch (cause) {
        resume(Effect.fail(new StoreError({ message: "Failed to open IndexedDB", cause })));
        return;
      }
      request.onupgradeneeded = (): void => {
        const opened = request.result;
        if (!opened.objectStoreNames.contains(storeName)) {
          opened.createObjectStore(storeName, { keyPath: "keyHash" });
        }
      };
      request.onsuccess = (): void => {
        const opened = request.result;
        // If the store is missing (DB created elsewhere without it), bump the
        // version to add it.
        if (opened.objectStoreNames.contains(storeName)) {
          resume(Effect.succeed(opened));
          return;
        }
        const version = opened.version + 1;
        opened.close();
        const upgrade = indexedDB.open(databaseName, version);
        upgrade.onupgradeneeded = (): void => {
          const u = upgrade.result;
          if (!u.objectStoreNames.contains(storeName)) {
            u.createObjectStore(storeName, { keyPath: "keyHash" });
          }
        };
        upgrade.onsuccess = (): void => resume(Effect.succeed(upgrade.result));
        upgrade.onerror = (): void =>
          resume(
            Effect.fail(
              new StoreError({ message: "Failed to upgrade IndexedDB", cause: upgrade.error })
            )
          );
      };
      request.onerror = (): void =>
        resume(
          Effect.fail(new StoreError({ message: "Failed to open IndexedDB", cause: request.error }))
        );
    });

    // Run `build` inside a transaction of `mode` and resolve with the request
    // result. Maps any failure to a StoreError.
    const run = <A>(
      message: string,
      mode: IDBTransactionMode,
      build: (store: IDBObjectStore) => IDBRequest<A>
    ): Effect.Effect<A, StoreError> =>
      Effect.callback<A, StoreError>((resume) => {
        let request: IDBRequest<A>;
        try {
          const tx = db.transaction(storeName, mode);
          request = build(tx.objectStore(storeName));
        } catch (cause) {
          resume(Effect.fail(new StoreError({ message, cause })));
          return;
        }
        request.onsuccess = (): void => resume(Effect.succeed(request.result));
        request.onerror = (): void =>
          resume(Effect.fail(new StoreError({ message, cause: request.error })));
      });

    const store: CacheStore = {
      get: (key) =>
        run<StoredRecord | undefined>("IndexedDB get failed", "readonly", (s) =>
          s.get(SyncKey.hash(key))
        ).pipe(Effect.map((record) => Option.fromUndefinedOr(record?.entry))),

      set: (entry) =>
        run<IDBValidKey>("IndexedDB set failed", "readwrite", (s) =>
          s.put({ keyHash: SyncKey.hash(entry.key), entry } satisfies StoredRecord)
        ).pipe(Effect.asVoid),

      remove: (key) =>
        Effect.gen(function* () {
          const keyHash = SyncKey.hash(key);
          const existing = yield* run<StoredRecord | undefined>(
            "IndexedDB remove failed",
            "readonly",
            (s) => s.get(keyHash)
          );
          if (existing === undefined) return false;
          yield* run<undefined>("IndexedDB remove failed", "readwrite", (s) => s.delete(keyHash));
          return true;
        }),

      // O(n): IndexedDB cannot filter by hierarchical key, so all records are
      // fetched and filtered in memory.
      entries: (filter?: KeyFilter) =>
        run<Array<StoredRecord>>("IndexedDB entries failed", "readonly", (s) => s.getAll()).pipe(
          Effect.map((records) => {
            const all = records.map((record) => record.entry);
            return filter === undefined
              ? all
              : all.filter((entry) => SyncKey.matches(entry.key, filter));
          })
        ),

      clear: run<undefined>("IndexedDB clear failed", "readwrite", (s) => s.clear()).pipe(
        Effect.asVoid
      ),

      size: run<number>("IndexedDB size failed", "readonly", (s) => s.count()),
    };

    return store;
  });

/**
 * A `Layer` providing core's `CacheStore` service backed by IndexedDB.
 */
export const layer = (options?: IndexedDbCacheStoreOptions): Layer.Layer<CacheStore, StoreError> =>
  Layer.effect(CacheStore)(make(options));
