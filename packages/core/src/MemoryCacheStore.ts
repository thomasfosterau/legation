/**
 * MemoryCacheStore
 *
 * An in-memory `CacheStore` implementation backed by a `Map`, with an
 * optional entry limit using least-recently-written eviction. Suitable for
 * tests, short-lived processes, and as the L1 store in layered setups.
 */

import { Effect, Layer, Option } from "effect";
import { CacheStore } from "./CacheStore.js";
import type { CacheEntry } from "./CacheStore.js";
import * as SyncKey from "./SyncKey.js";

/**
 * Options for the in-memory cache store.
 */
export interface MemoryCacheStoreOptions {
  /** Maximum number of entries kept. Oldest entries are evicted first. */
  readonly maxEntries?: number | undefined;
}

/**
 * Construct an in-memory cache store.
 */
export const make = (options?: MemoryCacheStoreOptions): CacheStore => {
  // Map preserves insertion order, which we use for least-recently-written
  // eviction: re-setting a key moves it to the back.
  const entries = new Map<SyncKey.SyncKeyHash, CacheEntry>();
  const maxEntries = options?.maxEntries;

  return {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(entries.get(SyncKey.hash(key)))),

    set: (entry) =>
      Effect.sync(() => {
        const keyHash = SyncKey.hash(entry.key);
        entries.delete(keyHash);
        entries.set(keyHash, entry);
        if (maxEntries !== undefined && entries.size > maxEntries) {
          const oldest = entries.keys().next();
          if (!oldest.done) {
            entries.delete(oldest.value);
          }
        }
      }),

    remove: (key) => Effect.sync(() => entries.delete(SyncKey.hash(key))),

    entries: (filter) =>
      Effect.sync(() => {
        const all = Array.from(entries.values());
        return filter === undefined
          ? all
          : all.filter((entry) => SyncKey.matches(entry.key, filter));
      }),

    clear: Effect.sync(() => {
      entries.clear();
    }),

    size: Effect.sync(() => entries.size),
  };
};

/**
 * A layer providing an in-memory `CacheStore`.
 */
export const layer = (options?: MemoryCacheStoreOptions): Layer.Layer<CacheStore> =>
  Layer.sync(CacheStore)(() => make(options));
