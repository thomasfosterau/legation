/**
 * HttpCacheInvalidation
 *
 * Drives HTTP-cache tag invalidation from collection changes (issue #49): as
 * synced changes land, evict the cached responses tagged for the collections
 * that moved. This is the concrete wiring behind the collection-driven
 * invalidation core's `HttpCache` module promises — the missing link between a
 * pull arriving and the stale-while-revalidate cache noticing.
 *
 * The tag convention is `collection:{name}` (the default {@link defaultTagFor}):
 * a cached response carrying `collection:todos` is evicted whenever the `todos`
 * collection changes. That is a collection-level granularity ceiling — every
 * response tagged for a changed collection is evicted, even one that a finer
 * diff would have spared. A per-row `collection:{name}:{id}` convention could
 * follow the same shape once patch-op row ids are plumbed through to the change
 * feed; that is future work, not implemented here. See CONTEXT.md's "Tag" entry.
 *
 * The change feed comes from an engine's `engineEvents` via
 * {@link collectionChanges}, so a synced change reaching a client with no
 * pending journal (the common case, where a pull emits a `Patch` and no
 * `ViewRebuilt`) still invalidates: it reads the touched collections off the
 * `PullCompleted` event, not off `ViewRebuilt` alone.
 */

import type { ClientEngine, HttpCache } from "@legation/effect/internal";
import { Effect, Stream } from "effect";
import type { Scope } from "effect";

/** The default tag convention: `collection:{name}`. */
export const defaultTagFor = (collection: string): string => `collection:${collection}`;

/** The touched collections an engine event carries, or none for other events. */
const touchedCollections = (event: ClientEngine.EngineEvent): ReadonlyArray<string> => {
  switch (event._tag) {
    case "PullCompleted":
      return event.collections;
    case "ViewRebuilt":
      return event.collections ?? [];
    default:
      return [];
  }
};

/**
 * Derive the change feed from an engine's event stream: the distinct
 * collections each `PullCompleted` (always present) and scoped `ViewRebuilt`
 * (when present) touched, dropping events that touched nothing. Feed the result
 * to {@link invalidateOnChanges}.
 */
export const collectionChanges = (
  events: Stream.Stream<ClientEngine.EngineEvent>
): Stream.Stream<ReadonlyArray<string>> =>
  events.pipe(
    Stream.map(touchedCollections),
    Stream.filter((collections) => collections.length > 0)
  );

export interface InvalidateOnChangesOptions {
  readonly store: HttpCache.ResponseCacheStore;
  /** Touched collection names per change (e.g. from {@link collectionChanges}). */
  readonly changes: Stream.Stream<ReadonlyArray<string>>;
  /** Map a collection name to its cache tag; defaults to {@link defaultTagFor}. */
  readonly tagFor?: (collection: string) => string;
}

/**
 * Fork a scoped fibre that, per emitted batch of touched collections, evicts
 * every cached response tagged for those collections (`store.invalidateTags`).
 * Invalidation cost stays proportional to the store's tag enumeration — this
 * scans no more than `invalidateTags` already does. Runs until the scope
 * closes; a store error is logged and swallowed, never fatal to the fibre, so a
 * transient cache failure doesn't stop future invalidations.
 */
export const invalidateOnChanges = (
  options: InvalidateOnChangesOptions
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const tagFor = options.tagFor ?? defaultTagFor;
    yield* Effect.forkScoped(
      Stream.runForEach(options.changes, (collections) =>
        options.store
          .invalidateTags(collections.map(tagFor))
          .pipe(Effect.catch((error) => Effect.logWarning("HTTP cache invalidation failed", error)))
      )
    );
  });
