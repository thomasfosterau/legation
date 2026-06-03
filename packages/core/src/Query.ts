/**
 * Query
 *
 * Query descriptors and query state. A `QueryDescriptor` declares
 * everything needed to load and cache a piece of data: its key, its
 * loader effect, freshness windows, retry policy, and tags.
 *
 * Descriptors are consumed by `SyncCache.read` (via `toReadOptions`) and
 * by the client package's query manager, which adds observation and
 * automatic refetching on top.
 */

import { Duration, Effect, Option, Schedule } from "effect";
import type { CacheEntry } from "./CacheStore.js";
import { freshness } from "./CacheStore.js";
import type { ReadOptions } from "./SyncCache.js";
import type { SyncKey } from "./SyncKey.js";

/**
 * Retry policy for query loaders.
 */
export interface RetryPolicy {
  /** Maximum number of retries (not counting the initial attempt). */
  readonly times: number;
  /** Base delay between attempts. Default: 1 second. */
  readonly baseDelay?: Duration.Input | undefined;
  /** Exponential backoff growth factor. Default: 2. */
  readonly factor?: number | undefined;
}

/**
 * Declarative description of a query.
 */
export interface QueryDescriptor<A, E = never, R = never> {
  readonly key: SyncKey;
  /** Loads the value from its source of truth. */
  readonly loader: Effect.Effect<A, E, R>;
  /** How long a loaded value stays fresh. Default: stale immediately. */
  readonly staleTime?: Duration.Input | undefined;
  /** How long a loaded value may live before eviction. Default: never expires. */
  readonly timeToLive?: Duration.Input | undefined;
  /** Tags for group invalidation. */
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Serve stale values while refreshing in the background. */
  readonly staleWhileRevalidate?: boolean | undefined;
  /** Retry policy applied to the loader. */
  readonly retry?: RetryPolicy | undefined;
}

/**
 * Construct a query descriptor.
 */
export const make = <A, E = never, R = never>(
  descriptor: QueryDescriptor<A, E, R>
): QueryDescriptor<A, E, R> => descriptor;

/**
 * Wrap a loader with the descriptor's retry policy.
 */
export const applyRetry = <A, E, R>(
  loader: Effect.Effect<A, E, R>,
  policy: RetryPolicy | undefined
): Effect.Effect<A, E, R> => {
  if (policy === undefined || policy.times <= 0) {
    return loader;
  }
  const baseDelay = policy.baseDelay ?? Duration.seconds(1);
  const factor = policy.factor ?? 2;
  const schedule = Schedule.both(
    Schedule.exponential(baseDelay, factor),
    Schedule.recurs(policy.times)
  );
  return Effect.retry(loader, schedule);
};

/**
 * Convert a query descriptor into `SyncCache.read` options.
 */
export const toReadOptions = <A, E, R>(
  descriptor: QueryDescriptor<A, E, R>,
  overrides?: {
    readonly forceRefresh?: boolean | undefined;
  }
): ReadOptions<A, E, R> => ({
  key: descriptor.key,
  loader: applyRetry(descriptor.loader, descriptor.retry),
  staleTime: descriptor.staleTime,
  timeToLive: descriptor.timeToLive,
  tags: descriptor.tags,
  staleWhileRevalidate: descriptor.staleWhileRevalidate,
  forceRefresh: overrides?.forceRefresh,
});

/**
 * Lifecycle status of an observed query.
 */
export type QueryStatus = "initial" | "loading" | "success" | "failure";

/**
 * The state of an observed query, as published to subscribers.
 */
export interface QueryState<A, E = unknown> {
  readonly key: SyncKey;
  readonly status: QueryStatus;
  readonly data: Option.Option<A>;
  readonly error: Option.Option<E>;
  /** `true` while a load/refresh is in flight. */
  readonly isFetching: boolean;
  /** `true` when the cached data is stale. */
  readonly isStale: boolean;
  /** Epoch millis of the last successful load, if any. */
  readonly updatedAt: number | null;
}

/**
 * The initial state of a query before anything has happened.
 */
export const initialState = <A, E = unknown>(key: SyncKey): QueryState<A, E> => ({
  key,
  status: "initial",
  data: Option.none(),
  error: Option.none(),
  isFetching: false,
  isStale: true,
  updatedAt: null,
});

/**
 * State transition: a load started.
 */
export const toLoading = <A, E>(state: QueryState<A, E>): QueryState<A, E> => ({
  ...state,
  status: Option.isSome(state.data) ? state.status : "loading",
  isFetching: true,
});

/**
 * State transition: a load succeeded with `entry`.
 */
export const toSuccess = <A, E>(
  state: QueryState<A, E>,
  entry: CacheEntry<A>,
  now: number
): QueryState<A, E> => ({
  ...state,
  status: "success",
  data: Option.some(entry.value),
  error: Option.none(),
  isFetching: false,
  isStale: freshness(entry, now) !== "fresh",
  updatedAt: entry.updatedAt,
});

/**
 * State transition: a load failed with `error`.
 */
export const toFailure = <A, E>(state: QueryState<A, E>, error: E): QueryState<A, E> => ({
  ...state,
  status: "failure",
  error: Option.some(error),
  isFetching: false,
});

/**
 * State transition: the cached value was invalidated.
 */
export const toStale = <A, E>(state: QueryState<A, E>): QueryState<A, E> => ({
  ...state,
  isStale: true,
});
