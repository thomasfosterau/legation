/**
 * CacheStore
 *
 * The storage backend for the cache engine. A `CacheStore` is a flat,
 * key-addressed store of `CacheEntry` values. Implementations may persist
 * to memory, browser storage, a service-worker cache, Redis, SQL, etc.
 *
 * Freshness/staleness decisions are made by the cache engine
 * (`SyncCache`), not the store: the store only persists entries and their
 * timing metadata.
 */

import { Context, Effect, Option } from "effect";
import type { StoreError } from "./Errors.js";
import type { SyncKey, SyncKeyHash, KeyFilter } from "./SyncKey.js";
import type { Version } from "./Versioned.js";

/**
 * A single cached value plus its timing and identity metadata.
 */
export interface CacheEntry<A = unknown> {
  /** The key this entry is stored under. */
  readonly key: SyncKey;
  /** The cached value. */
  readonly value: A;
  /** Epoch milliseconds when the entry was written. */
  readonly updatedAt: number;
  /** Epoch milliseconds after which the entry is stale (revalidate). `null` = never stale. */
  readonly staleAt: number | null;
  /** Epoch milliseconds after which the entry should be evicted. `null` = never expires. */
  readonly expiresAt: number | null;
  /** Optional resource version for conflict detection. */
  readonly version?: Version | undefined;
  /** Tags for group invalidation. */
  readonly tags: ReadonlyArray<string>;
}

/**
 * Freshness of a cache entry relative to a point in time.
 */
export type Freshness = "fresh" | "stale" | "expired";

/**
 * Compute the freshness of an entry at time `now`.
 */
export const freshness = (entry: CacheEntry, now: number): Freshness => {
  if (entry.expiresAt !== null && now >= entry.expiresAt) return "expired";
  if (entry.staleAt !== null && now >= entry.staleAt) return "stale";
  return "fresh";
};

/**
 * The storage backend interface used by the cache engine.
 */
export interface CacheStore {
  /** Read the entry stored under `key`, if any. */
  readonly get: (key: SyncKey) => Effect.Effect<Option.Option<CacheEntry>, StoreError>;
  /** Write an entry (insert or replace). */
  readonly set: (entry: CacheEntry) => Effect.Effect<void, StoreError>;
  /** Delete the entry stored under `key`. Returns `true` if an entry was removed. */
  readonly remove: (key: SyncKey) => Effect.Effect<boolean, StoreError>;
  /** List all entries matching a key filter (all entries when no filter given). */
  readonly entries: (filter?: KeyFilter) => Effect.Effect<ReadonlyArray<CacheEntry>, StoreError>;
  /** Remove every entry. */
  readonly clear: Effect.Effect<void, StoreError>;
  /** Number of stored entries. */
  readonly size: Effect.Effect<number, StoreError>;
}

/**
 * Service key for the cache store backend.
 */
export const CacheStore = Context.Service<CacheStore>(
  "@thomasfosterau/effect-sync-core/CacheStore"
);

/**
 * Map-like description of cache store contents, used by snapshot/restore
 * helpers and by stores that persist to external key-value backends.
 */
export type CacheSnapshot = ReadonlyArray<readonly [SyncKeyHash, CacheEntry]>;
