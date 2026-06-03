/**
 * WriteThroughCache
 *
 * A thin, opinionated wrapper over the core `SyncCache` engine tuned for
 * cache-engine use in service workers, edge runtimes, and servers.
 *
 * Where `SyncCache` exposes the full read/write/invalidation surface, this
 * service narrows it to the vocabulary a caching layer needs:
 *
 * - `get` — read-through, with a single freshness window (`swr`) and a
 *   single eviction window (`ttl`).
 * - `put` — write-through (run the upstream writer, then persist its
 *   canonical result), with optional optimistic values.
 * - `getPaginated` / `getNextPage` — read-through paginated queries,
 *   delegating to core `Pagination`.
 * - `invalidate` / `invalidateTags` / `purge` / `clear` — cache eviction.
 * - `events` — the underlying cache event stream.
 *
 * The freshness model: `swr` is the window during which a cached value is
 * served without revalidation. After `swr` elapses the value is *stale*
 * and the next `get` serves it immediately while revalidating in the
 * background (stale-while-revalidate). After `ttl` elapses the value is
 * evicted and the next `get` blocks on a fresh load.
 */

import {
  CacheStore,
  Pagination,
  type StoreError,
  SyncCache,
  type SyncKey,
} from "@thomasfosterau/effect-sync-core";
import { Context, type Duration, Effect, Layer, type Stream } from "effect";

/**
 * Options shared by read-through and write-through accesses.
 */
export interface CacheOptions {
  /** How long the entry may live before eviction. Default: never expires. */
  readonly ttl?: Duration.Input | undefined;
  /**
   * The stale-while-revalidate freshness window: how long the value is
   * served without revalidating. Default: stale immediately.
   */
  readonly swr?: Duration.Input | undefined;
  /** Tags for group invalidation. */
  readonly tags?: ReadonlyArray<string> | undefined;
}

/**
 * Options for a read-through `get`.
 */
export interface GetOptions<A, E, R> extends CacheOptions {
  readonly key: SyncKey.SyncKey;
  /** The effect that loads the value on a cache miss or expiry. */
  readonly loader: Effect.Effect<A, E, R>;
  /** Bypass the cached value and always run the loader. */
  readonly forceRefresh?: boolean | undefined;
}

/**
 * Options for a write-through `put`.
 */
export interface PutOptions<A, E, R> extends CacheOptions {
  readonly key: SyncKey.SyncKey;
  /** The effect that performs the upstream write and returns the canonical value. */
  readonly writer: Effect.Effect<A, E, R>;
  /**
   * A value to store optimistically while the writer runs. On writer
   * failure the previous entry is restored.
   */
  readonly optimistic?: A | undefined;
}

/**
 * The write-through cache engine service.
 */
export interface WriteThroughCache {
  /**
   * Read-through access: serve a fresh cached value, serve-and-revalidate
   * a stale one, or load on miss/expiry and populate.
   */
  readonly get: <A, E, R>(options: GetOptions<A, E, R>) => Effect.Effect<A, E | StoreError, R>;
  /**
   * Write-through access: run the writer against the upstream, then
   * persist its canonical result. Optionally apply an optimistic value
   * while the writer is in flight.
   */
  readonly put: <A, E, R>(options: PutOptions<A, E, R>) => Effect.Effect<A, E | StoreError, R>;
  /** Read the first page of a paginated query through the cache. */
  readonly getPaginated: <A, Cursor, E, R>(
    descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
  ) => Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R>;
  /** Load and append the next page of a cached paginated query. */
  readonly getNextPage: <A, Cursor, E, R>(
    descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
  ) => Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R>;
  /** Mark matching entries stale so the next `get` re-fetches them. */
  readonly invalidate: (filter: SyncKey.KeyFilter) => Effect.Effect<void, StoreError>;
  /** Mark entries carrying any of the given tags stale. */
  readonly invalidateTags: (tags: ReadonlyArray<string>) => Effect.Effect<void, StoreError>;
  /** Remove a single entry entirely. */
  readonly purge: (key: SyncKey.SyncKey) => Effect.Effect<boolean, StoreError>;
  /** Remove every entry. */
  readonly clear: Effect.Effect<void, StoreError>;
  /** Every cache change, as a stream. */
  readonly events: Stream.Stream<SyncCache.CacheEvent>;
}

/**
 * Service key for the write-through cache engine.
 */
export const WriteThroughCache = Context.Service<WriteThroughCache>(
  "@thomasfosterau/effect-sync-cache/WriteThroughCache"
);

/**
 * Build a `WriteThroughCache` from the `SyncCache` in context.
 *
 * `swr` maps to `staleTime` with `staleWhileRevalidate: true`, and `ttl`
 * maps to `timeToLive`.
 */
export const make: Effect.Effect<WriteThroughCache, never, SyncCache.SyncCache> = Effect.gen(
  function* () {
    const cache = yield* SyncCache.SyncCache;

    const get = <A, E, R>(options: GetOptions<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
      cache.read<A, E, R>({
        key: options.key,
        loader: options.loader,
        staleTime: options.swr,
        timeToLive: options.ttl,
        tags: options.tags,
        staleWhileRevalidate: true,
        forceRefresh: options.forceRefresh,
      });

    const put = <A, E, R>(options: PutOptions<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
      cache.write<A, E, R>({
        key: options.key,
        writer: options.writer,
        optimistic: options.optimistic,
        staleTime: options.swr,
        timeToLive: options.ttl,
        tags: options.tags,
      });

    const getPaginated = <A, Cursor, E, R>(
      descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
    ): Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R> =>
      Pagination.readFirstPage(cache, descriptor);

    const getNextPage = <A, Cursor, E, R>(
      descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
    ): Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R> =>
      Pagination.fetchNextPage(cache, descriptor);

    return {
      get,
      put,
      getPaginated,
      getNextPage,
      invalidate: cache.invalidate,
      invalidateTags: cache.invalidateTags,
      purge: cache.remove,
      clear: cache.clear,
      events: cache.events,
    } satisfies WriteThroughCache;
  }
);

/**
 * A layer providing the write-through cache, requiring a `CacheStore`.
 *
 * The core `SyncCache.layer` is composed internally, so callers only need
 * to provide a `CacheStore` (e.g. `MemoryCacheStore.layer()` or the
 * `KeyValueStoreAdapter`).
 */
export const layer: Layer.Layer<WriteThroughCache, never, CacheStore> = Layer.effect(
  WriteThroughCache
)(make).pipe(Layer.provide(SyncCache.layer));
