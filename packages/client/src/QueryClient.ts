/**
 * QueryClient
 *
 * A TanStack-Query-style query manager built on top of the core
 * `SyncCache`. It turns declarative `Query.QueryDescriptor`s into
 * read-through fetches and, crucially, into **observable** query state: a
 * `Stream` of `Query.QueryState` that emits a loading state, then the
 * fetched value, then keeps emitting as the underlying cache entry changes
 * (server pushes, invalidations, removals).
 *
 * It also exposes the imperative cache operations a query layer needs:
 * prefetching, direct reads/writes of cached data, invalidation, paginated
 * fetches, and mutation execution.
 */

import { Clock, Context, Effect, Layer, Option, Stream } from "effect";
import {
  CacheStore,
  Mutation,
  Pagination,
  Query,
  SyncCache,
  SyncKey,
} from "@thomasfosterau/effect-sync-core";
import type { CacheEntry, StoreError } from "@thomasfosterau/effect-sync-core";

/**
 * The query manager service.
 */
export interface QueryClient {
  /** Read-through fetch: serve from cache or run the loader. */
  readonly fetch: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Effect.Effect<A, E | StoreError, R>;
  /** Like {@link fetch}, but returns the full read result with cache metadata. */
  readonly fetchEntry: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Effect.Effect<SyncCache.ReadResult<A>, E | StoreError, R>;
  /** Force a fresh load, bypassing any cached value. */
  readonly refetch: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Effect.Effect<A, E | StoreError, R>;
  /**
   * Observe a query as a stream of {@link Query.QueryState}.
   *
   * The stream (1) emits a loading state, (2) fetches and emits a
   * success/failure state, then (3) listens to cache changes for the
   * descriptor's key: `Updated` events emit a new success state,
   * `Invalidated` events trigger a refetch and emit the new state, and
   * `Removed` events emit the initial (empty) state again.
   */
  readonly observe: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Stream.Stream<Query.QueryState<A, E>, never, R>;
  /** Fetch a query and discard the result and any error (cache warming). */
  readonly prefetch: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Effect.Effect<void, never, R>;
  /** Read the currently-cached value for a key without loading. */
  readonly getQueryData: <A = unknown>(
    key: SyncKey.SyncKey
  ) => Effect.Effect<Option.Option<A>, StoreError>;
  /** Write a value directly into the cache under a key. */
  readonly setQueryData: <A>(key: SyncKey.SyncKey, value: A) => Effect.Effect<void, StoreError>;
  /** Mark matching cache entries stale. */
  readonly invalidate: (filter: SyncKey.KeyFilter) => Effect.Effect<void, StoreError>;
  /** Mark entries carrying any of the given tags stale. */
  readonly invalidateTags: (tags: ReadonlyArray<string>) => Effect.Effect<void, StoreError>;
  /** Read the first page of a paginated query through the cache. */
  readonly fetchPaginated: <A, Cursor, E, R>(
    descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
  ) => Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R>;
  /** Load and append the next page of a paginated query. */
  readonly fetchNextPage: <A, Cursor, E, R>(
    descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
  ) => Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R>;
  /** Execute a mutation against the cache (optimistic patches, rollback, invalidation). */
  readonly mutate: <Input, A, E, R>(
    descriptor: Mutation.MutationDescriptor<Input, A, E, R>,
    input: Input
  ) => Effect.Effect<A, E | StoreError, R>;
}

/**
 * Service key for the query manager.
 */
export const QueryClient = Context.Service<QueryClient>(
  "@thomasfosterau/effect-sync-client/QueryClient"
);

/**
 * Build a `QueryClient` from the `SyncCache` in context.
 */
export const make: Effect.Effect<QueryClient, never, SyncCache.SyncCache> = Effect.gen(
  function* () {
    const cache = yield* SyncCache.SyncCache;

    const fetch = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>
    ): Effect.Effect<A, E | StoreError, R> => cache.read(Query.toReadOptions(descriptor));

    const fetchEntry = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>
    ): Effect.Effect<SyncCache.ReadResult<A>, E | StoreError, R> =>
      cache.readEntry(Query.toReadOptions(descriptor));

    const refetch = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>
    ): Effect.Effect<A, E | StoreError, R> =>
      cache.read(Query.toReadOptions(descriptor, { forceRefresh: true }));

    // Fetch the descriptor and fold the result into a query state, starting
    // from `previous`. Loader failures become a `failure` state rather than
    // failing the stream, so observers see errors as data.
    const fetchState = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>,
      previous: Query.QueryState<A, E>,
      forceRefresh: boolean
    ): Effect.Effect<Query.QueryState<A, E>, never, R> =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          cache.readEntry(Query.toReadOptions(descriptor, { forceRefresh }))
        );
        const now = yield* Clock.currentTimeMillis;
        if (result._tag === "Success") {
          return Query.toSuccess(previous, result.success.entry, now);
        }
        return Query.toFailure(previous, result.failure as E);
      });

    const observe = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>
    ): Stream.Stream<Query.QueryState<A, E>, never, R> => {
      const initial = Query.initialState<A, E>(descriptor.key);
      const loading = Query.toLoading(initial);

      // Emit loading immediately, then the result of the initial fetch.
      const head: Stream.Stream<Query.QueryState<A, E>, never, R> = Stream.concat(
        Stream.succeed(loading),
        Stream.fromEffect(fetchState(descriptor, loading, false))
      );

      // After the initial fetch, react to cache changes for this key. We
      // build the tail lazily so it starts from the settled head state.
      const tail = Stream.unwrap(
        fetchState(descriptor, loading, false).pipe(
          Effect.map((settled) => {
            let current = settled;
            return Stream.mapEffect(
              cache.changes(SyncKey.exactFilter(descriptor.key)),
              (event): Effect.Effect<Query.QueryState<A, E>, never, R> =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "Updated": {
                      const now = yield* Clock.currentTimeMillis;
                      current = Query.toSuccess(current, event.entry as CacheEntry<A>, now);
                      return current;
                    }
                    case "Invalidated": {
                      const refreshed = yield* fetchState(descriptor, current, true);
                      current = refreshed;
                      return current;
                    }
                    case "Removed":
                    case "Cleared": {
                      current = Query.initialState<A, E>(descriptor.key);
                      return current;
                    }
                  }
                })
            );
          })
        )
      );

      return Stream.concat(head, tail);
    };

    const prefetch = <A, E, R>(
      descriptor: Query.QueryDescriptor<A, E, R>
    ): Effect.Effect<void, never, R> => Effect.ignore(fetch(descriptor));

    const getQueryData = <A = unknown>(
      key: SyncKey.SyncKey
    ): Effect.Effect<Option.Option<A>, StoreError> =>
      Effect.map(cache.peek<A>(key), (entry) => Option.map(entry, (e) => e.value));

    const setQueryData = <A>(key: SyncKey.SyncKey, value: A): Effect.Effect<void, StoreError> =>
      Effect.asVoid(cache.set(key, value));

    const invalidate = (filter: SyncKey.KeyFilter): Effect.Effect<void, StoreError> =>
      cache.invalidate(filter);

    const invalidateTags = (tags: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
      cache.invalidateTags(tags);

    const fetchPaginated = <A, Cursor, E, R>(
      descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
    ): Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R> =>
      Pagination.readFirstPage(cache, descriptor);

    const fetchNextPage = <A, Cursor, E, R>(
      descriptor: Pagination.PaginatedQueryDescriptor<A, Cursor, E, R>
    ): Effect.Effect<Pagination.PaginatedResult<A, Cursor>, E | StoreError, R> =>
      Pagination.fetchNextPage(cache, descriptor);

    const mutate = <Input, A, E, R>(
      descriptor: Mutation.MutationDescriptor<Input, A, E, R>,
      input: Input
    ): Effect.Effect<A, E | StoreError, R> => Mutation.execute(cache, descriptor, input);

    return {
      fetch,
      fetchEntry,
      refetch,
      observe,
      prefetch,
      getQueryData,
      setQueryData,
      invalidate,
      invalidateTags,
      fetchPaginated,
      fetchNextPage,
      mutate,
    } satisfies QueryClient;
  }
);

/**
 * A layer providing the query manager.
 *
 * It composes `SyncCache.layer` internally via `Layer.provide`, so the only
 * unsatisfied requirement is a `CacheStore`. Provide
 * `MemoryCacheStore.layer()` (or any other store) underneath it.
 */
export const layer: Layer.Layer<QueryClient, never, CacheStore> = Layer.effect(QueryClient)(
  make
).pipe(Layer.provide(SyncCache.layer));
