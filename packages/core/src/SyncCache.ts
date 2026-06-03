/**
 * SyncCache
 *
 * The cache engine at the heart of the sync packages. It layers
 * read-through and write-through semantics, request deduplication,
 * stale-while-revalidate, tag/prefix invalidation, and a cache event
 * stream on top of a pluggable `CacheStore` backend.
 *
 * - **read-through**: `read` consults the store first and only runs the
 *   loader on a miss (or when the entry is stale/expired), writing the
 *   result back to the store.
 * - **write-through**: `write` runs the writer (e.g. an upstream HTTP
 *   call) and persists its canonical result to the store, optionally
 *   applying an optimistic value while the writer is in flight.
 * - **deduplication**: concurrent reads of the same key share a single
 *   loader execution.
 * - **events**: every change to the cache is published as a `CacheEvent`,
 *   which is what query observers and server fan-out subscribe to.
 */

import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  MutableHashMap,
  Option,
  PubSub,
  Scope,
  Stream,
} from "effect";
import { CacheStore, freshness } from "./CacheStore.js";
import type { CacheEntry } from "./CacheStore.js";
import type { StoreError } from "./Errors.js";
import * as SyncKey from "./SyncKey.js";
import type { KeyFilter, SyncKeyHash } from "./SyncKey.js";
import type { Version } from "./Versioned.js";

/**
 * Events published by the cache whenever its contents change.
 */
export type CacheEvent = Data.TaggedEnum<{
  Updated: {
    readonly entry: CacheEntry;
    /** `true` when the entry was written optimistically and may be rolled back. */
    readonly optimistic: boolean;
  };
  Removed: { readonly key: SyncKey.SyncKey };
  Invalidated: { readonly filter: KeyFilter };
  Cleared: {};
}>;

/**
 * Constructors and matchers for {@link CacheEvent}:
 * `CacheEvent.Updated({...})`, `CacheEvent.$is("Removed")`, `CacheEvent.$match`.
 */
export const CacheEvent = Data.taggedEnum<CacheEvent>();

const filterKeyOf = (filter: KeyFilter): SyncKey.SyncKey | undefined => {
  switch (filter._tag) {
    case "Exact":
      return filter.key;
    case "Prefix":
      return filter.prefix;
    case "Predicate":
      return undefined;
  }
};

const filtersMayOverlap = (a: KeyFilter, b: KeyFilter): boolean => {
  const keyA = filterKeyOf(a);
  const keyB = filterKeyOf(b);
  if (keyA === undefined || keyB === undefined) return true;
  return SyncKey.startsWith(keyA, keyB) || SyncKey.startsWith(keyB, keyA);
};

/**
 * Returns `true` when a cache event is relevant to keys selected by `filter`.
 */
export const eventMatches = (event: CacheEvent, filter: KeyFilter): boolean => {
  switch (event._tag) {
    case "Updated":
      return SyncKey.matches(event.entry.key, filter);
    case "Removed":
      return SyncKey.matches(event.key, filter);
    case "Invalidated":
      // Conservatively notify: an invalidation overlaps a watch filter
      // unless both name keys that provably do not overlap.
      return filtersMayOverlap(event.filter, filter);
    case "Cleared":
      return true;
  }
};

/**
 * Timing and identity options shared by reads and writes.
 */
export interface EntryOptions {
  /** How long the entry stays fresh. Default: stale immediately. */
  readonly staleTime?: Duration.Input | undefined;
  /** How long the entry may live before eviction. Default: never expires. */
  readonly timeToLive?: Duration.Input | undefined;
  /** Tags for group invalidation. */
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Resource version for conflict detection. */
  readonly version?: Version | undefined;
}

/**
 * Options for a read-through cache access.
 */
export interface ReadOptions<A, E, R> extends EntryOptions {
  readonly key: SyncKey.SyncKey;
  /** The effect that loads the value on a cache miss. */
  readonly loader: Effect.Effect<A, E, R>;
  /** Bypass the cached value and always run the loader. */
  readonly forceRefresh?: boolean | undefined;
  /**
   * When the cached value is stale (but not expired), return it
   * immediately and refresh in the background instead of blocking.
   */
  readonly staleWhileRevalidate?: boolean | undefined;
}

/**
 * Options for a write-through cache access.
 */
export interface WriteOptions<A, E, R> extends EntryOptions {
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
 * The result of a read, including whether it was served from the store.
 */
export interface ReadResult<A> {
  readonly value: A;
  readonly entry: CacheEntry<A>;
  /** `true` when the value came from the store without running the loader. */
  readonly hit: boolean;
}

/**
 * The cache engine service.
 */
export interface SyncCache {
  /** Read-through access: serve from cache or load and populate. */
  readonly read: <A, E, R>(options: ReadOptions<A, E, R>) => Effect.Effect<A, E | StoreError, R>;
  /** Like `read`, but also reports cache-hit metadata. */
  readonly readEntry: <A, E, R>(
    options: ReadOptions<A, E, R>
  ) => Effect.Effect<ReadResult<A>, E | StoreError, R>;
  /** Write-through access: run the writer, then persist its result. */
  readonly write: <A, E, R>(options: WriteOptions<A, E, R>) => Effect.Effect<A, E | StoreError, R>;
  /** Store a value directly without consulting any upstream. */
  readonly set: <A>(
    key: SyncKey.SyncKey,
    value: A,
    options?: EntryOptions
  ) => Effect.Effect<CacheEntry<A>, StoreError>;
  /** Update a cached value in place (no-op when the key is missing). */
  readonly update: <A>(
    key: SyncKey.SyncKey,
    f: (current: A) => A
  ) => Effect.Effect<Option.Option<CacheEntry<A>>, StoreError>;
  /** Look at the stored entry without triggering any load. */
  readonly peek: <A = unknown>(
    key: SyncKey.SyncKey
  ) => Effect.Effect<Option.Option<CacheEntry<A>>, StoreError>;
  /** Mark matching entries stale so the next read re-fetches them. */
  readonly invalidate: (filter: KeyFilter) => Effect.Effect<void, StoreError>;
  /** Mark entries carrying any of the given tags stale. */
  readonly invalidateTags: (tags: ReadonlyArray<string>) => Effect.Effect<void, StoreError>;
  /** Remove an entry entirely. */
  readonly remove: (key: SyncKey.SyncKey) => Effect.Effect<boolean, StoreError>;
  /** Remove every entry. */
  readonly clear: Effect.Effect<void, StoreError>;
  /** Every cache change, as a stream. */
  readonly events: Stream.Stream<CacheEvent>;
  /** Cache changes restricted to keys matching a filter. */
  readonly changes: (filter: KeyFilter) => Stream.Stream<CacheEvent>;
}

/**
 * Service key for the cache engine.
 */
export const SyncCache = Context.Service<SyncCache>("@thomasfosterau/effect-sync-core/SyncCache");

/**
 * Ambient defaults applied when a read/write does not specify its own
 * timing options. Override with `Effect.provideService(SyncCacheDefaults, {...})`
 * or a layer — no configuration is required (Effect `Reference` semantics).
 */
export interface SyncCacheDefaultsShape {
  /** Default freshness window. `null` = entries are stale immediately. */
  readonly staleTime: Duration.Duration | null;
  /** Default eviction window. `null` = entries never expire. */
  readonly timeToLive: Duration.Duration | null;
  /** Serve stale entries while refreshing in the background by default. */
  readonly staleWhileRevalidate: boolean;
}

/**
 * `Context.Reference` carrying the cache-wide defaults.
 */
export const SyncCacheDefaults = Context.Reference<SyncCacheDefaultsShape>(
  "@thomasfosterau/effect-sync-core/SyncCacheDefaults",
  {
    defaultValue: () => ({
      staleTime: null,
      timeToLive: null,
      staleWhileRevalidate: false,
    }),
  }
);

interface InFlight {
  readonly deferred: Deferred.Deferred<unknown, unknown>;
}

const toMillis = (input: Duration.Input | undefined): number | null =>
  input === undefined ? null : Duration.toMillis(input);

/**
 * Build a `SyncCache` from the `CacheStore` in context.
 *
 * The cache owns a `PubSub` for events which is shut down when the
 * surrounding scope closes.
 */
export const make: Effect.Effect<SyncCache, never, CacheStore | Scope.Scope> = Effect.gen(
  function* () {
    const store = yield* CacheStore;
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<CacheEvent>(), (ps) =>
      PubSub.shutdown(ps)
    );
    // In-flight loads keyed by hash; MutableHashMap is the idiomatic
    // fiber-safe mutable map for state confined to this service.
    const inFlight = MutableHashMap.empty<SyncKeyHash, InFlight>();
    const defaults = yield* SyncCacheDefaults;

    const publish = (event: CacheEvent): Effect.Effect<void> =>
      Effect.asVoid(PubSub.publish(pubsub, event));

    const buildEntry = <A>(
      key: SyncKey.SyncKey,
      value: A,
      now: number,
      options?: EntryOptions
    ): CacheEntry<A> => {
      const staleMillis =
        options?.staleTime !== undefined
          ? toMillis(options.staleTime)
          : defaults.staleTime === null
            ? null
            : Duration.toMillis(defaults.staleTime);
      const ttlMillis =
        options?.timeToLive !== undefined
          ? toMillis(options.timeToLive)
          : defaults.timeToLive === null
            ? null
            : Duration.toMillis(defaults.timeToLive);
      return {
        key,
        value,
        updatedAt: now,
        staleAt: staleMillis === null ? now : now + staleMillis,
        expiresAt: ttlMillis === null ? null : now + ttlMillis,
        version: options?.version,
        tags: options?.tags ?? [],
      };
    };

    const persistEntry = <A>(
      entry: CacheEntry<A>,
      optimistic: boolean
    ): Effect.Effect<CacheEntry<A>, StoreError> =>
      Effect.gen(function* () {
        yield* store.set(entry);
        yield* publish(CacheEvent.Updated({ entry, optimistic }));
        return entry;
      });

    const setValue = <A>(
      key: SyncKey.SyncKey,
      value: A,
      options?: EntryOptions
    ): Effect.Effect<CacheEntry<A>, StoreError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* persistEntry(buildEntry(key, value, now, options), false);
      });

    // Run the loader for a key with deduplication: the first caller runs
    // the loader, concurrent callers await the same result.
    const loadDeduped = <A, E, R>(
      options: ReadOptions<A, E, R>
    ): Effect.Effect<ReadResult<A>, E | StoreError, R> =>
      Effect.gen(function* () {
        const keyHash = SyncKey.hash(options.key);
        const running = Option.getOrUndefined(MutableHashMap.get(inFlight, keyHash));

        if (running !== undefined) {
          // Another fiber is already loading this key: share its result.
          const awaitLoader = Deferred.await(running.deferred) as Effect.Effect<A, E>;
          const value = yield* awaitLoader;
          const stored = yield* store.get(options.key);
          const now = yield* Clock.currentTimeMillis;
          const entry = Option.isSome(stored)
            ? (stored.value as CacheEntry<A>)
            : buildEntry(options.key, value, now, options);
          return { value, entry, hit: true } satisfies ReadResult<A>;
        }

        const deferred = yield* Deferred.make<unknown, unknown>();
        MutableHashMap.set(inFlight, keyHash, { deferred });

        const cleanup = Effect.sync(() => MutableHashMap.remove(inFlight, keyHash));

        const persist = (value: A): Effect.Effect<ReadResult<A>, StoreError> =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const entry = yield* persistEntry(buildEntry(options.key, value, now, options), false);
            return { value, entry, hit: false } satisfies ReadResult<A>;
          });

        return yield* options.loader.pipe(
          Effect.flatMap(persist),
          Effect.onExit((exit) =>
            cleanup.pipe(
              Effect.andThen(
                Deferred.done(
                  deferred,
                  Exit.isSuccess(exit)
                    ? Exit.succeed<unknown>(exit.value.value)
                    : (exit as Exit.Exit<unknown, unknown>)
                )
              )
            )
          )
        );
      });

    const readEntry = <A, E, R>(
      options: ReadOptions<A, E, R>
    ): Effect.Effect<ReadResult<A>, E | StoreError, R> =>
      Effect.gen(function* () {
        if (options.forceRefresh === true) {
          return yield* loadDeduped(options);
        }

        const existing = yield* store.get(options.key);
        if (Option.isNone(existing)) {
          return yield* loadDeduped(options);
        }

        const entry = existing.value as CacheEntry<A>;
        const now = yield* Clock.currentTimeMillis;
        const state = freshness(entry, now);

        if (state === "fresh") {
          return { value: entry.value, entry, hit: true } satisfies ReadResult<A>;
        }

        if (state === "stale" && (options.staleWhileRevalidate ?? defaults.staleWhileRevalidate)) {
          // Serve the stale value now and refresh in the background.
          // Refresh failures are logged (and the next read retries).
          yield* Effect.forkDetach(
            loadDeduped(options).pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning("SyncCache background refresh failed", cause)
              ),
              Effect.ignore
            )
          );
          return { value: entry.value, entry, hit: true } satisfies ReadResult<A>;
        }

        // Stale (blocking refresh) or expired: reload.
        return yield* loadDeduped(options);
      });

    const read = <A, E, R>(options: ReadOptions<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
      Effect.map(readEntry(options), (result) => result.value);

    const write = <A, E, R>(options: WriteOptions<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
      Effect.gen(function* () {
        const previous = yield* store.get(options.key);

        if (options.optimistic !== undefined) {
          const now = yield* Clock.currentTimeMillis;
          yield* persistEntry(buildEntry(options.key, options.optimistic, now, options), true);
        }

        // Restores the pre-write entry (or removes the optimistic one).
        const rollback: Effect.Effect<void, StoreError> = Option.isSome(previous)
          ? Effect.asVoid(persistEntry(previous.value, false))
          : Effect.gen(function* () {
              yield* store.remove(options.key);
              yield* publish(CacheEvent.Removed({ key: options.key }));
            });

        return yield* options.writer.pipe(
          Effect.flatMap((value) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* persistEntry(buildEntry(options.key, value, now, options), false);
              return value;
            })
          ),
          Effect.onError(() =>
            options.optimistic !== undefined ? Effect.ignore(rollback) : Effect.void
          )
        );
      });

    const update = <A>(
      key: SyncKey.SyncKey,
      f: (current: A) => A
    ): Effect.Effect<Option.Option<CacheEntry<A>>, StoreError> =>
      Effect.gen(function* () {
        const existing = yield* store.get(key);
        if (Option.isNone(existing)) {
          return Option.none<CacheEntry<A>>();
        }
        const entry = existing.value as CacheEntry<A>;
        const updated: CacheEntry<A> = { ...entry, value: f(entry.value) };
        yield* persistEntry(updated, false);
        return Option.some(updated);
      });

    const invalidate = (filter: KeyFilter): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const matching = yield* store.entries(filter);
        yield* Effect.forEach(matching, (entry) => store.set({ ...entry, staleAt: now }), {
          discard: true,
        });
        yield* publish(CacheEvent.Invalidated({ filter }));
      });

    const invalidateTags = (tags: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const tagSet = new Set(tags);
        const all = yield* store.entries();
        const matching = all.filter((entry) => entry.tags.some((tag) => tagSet.has(tag)));
        yield* Effect.forEach(matching, (entry) => store.set({ ...entry, staleAt: now }), {
          discard: true,
        });
        const matchingHashes = new Set(matching.map((entry) => SyncKey.hash(entry.key)));
        yield* publish(
          CacheEvent.Invalidated({
            filter: SyncKey.predicateFilter((key) => matchingHashes.has(SyncKey.hash(key))),
          })
        );
      });

    const remove = (key: SyncKey.SyncKey): Effect.Effect<boolean, StoreError> =>
      Effect.gen(function* () {
        const removed = yield* store.remove(key);
        if (removed) {
          yield* publish(CacheEvent.Removed({ key }));
        }
        return removed;
      });

    const clear: Effect.Effect<void, StoreError> = Effect.gen(function* () {
      yield* store.clear;
      yield* publish(CacheEvent.Cleared());
    });

    const events = Stream.fromPubSub(pubsub);

    const changes = (filter: KeyFilter): Stream.Stream<CacheEvent> =>
      Stream.filter(events, (event) => eventMatches(event, filter));

    const peek = <A = unknown>(
      key: SyncKey.SyncKey
    ): Effect.Effect<Option.Option<CacheEntry<A>>, StoreError> =>
      Effect.map(store.get(key), (option) => option as Option.Option<CacheEntry<A>>);

    return {
      read,
      readEntry,
      write,
      set: setValue,
      update,
      peek,
      invalidate,
      invalidateTags,
      remove,
      clear,
      events,
      changes,
    } satisfies SyncCache;
  }
);

/**
 * A layer providing the cache engine, requiring a `CacheStore`.
 */
export const layer: Layer.Layer<SyncCache, never, CacheStore> = Layer.effect(SyncCache)(make);
