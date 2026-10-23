/**
 * HttpCacheInvalidation
 *
 * Drives HTTP-cache tag invalidation from collection and row changes (issue
 * #49, extended per-row by #207): as synced changes land, evict the cached
 * responses tagged for the collections and individual rows that moved. This
 * is the concrete wiring behind the collection-driven invalidation core's
 * `HttpCache` module promises — the missing link between a pull arriving and
 * the stale-while-revalidate cache noticing.
 *
 * Two tag granularities share one convention (see CONTEXT.md's "Tag" entry;
 * #206's edge/KV invalidation sink reuses this same spelling):
 *
 * - Coarse: `collection:{name}` (the default {@link defaultTagFor}) — every
 *   response enumerating (part of) a collection carries it.
 * - Fine: `collection:{name}:{id}` (the default {@link defaultFineTagFor}) —
 *   a response carries one per row it actually contains, up to
 *   {@link FINE_TAG_ROW_BUDGET} (see {@link tagsFor}).
 *
 * A row change evicts **both**: the fine tag for that row, and the coarse tag
 * for its collection. The coarse eviction is not redundant, even though every
 * row's collection is already implied by the row itself — see the comment at
 * its use in {@link invalidateOnChanges}.
 *
 * The change feed comes from an engine's `engineEvents` via
 * {@link collectionChanges}, so a synced change reaching a client with no
 * pending journal (the common case, where a pull emits a `Patch` and no
 * `ViewRebuilt`) still invalidates: it reads the touched collections and rows
 * off the `PullCompleted` event, not off `ViewRebuilt` alone. `ViewRebuilt`
 * carries no row ids (it is the conservative "something in these collections
 * shifted" fallback), so it only ever contributes coarse tags.
 */

import type { ClientEngine, HttpCache } from "@thomasfosterau/legation-effect/internal";
import { Telemetry } from "@thomasfosterau/legation-effect/internal";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

/** The default coarse tag convention: `collection:{name}`. */
export const defaultTagFor = (collection: string): string => `collection:${collection}`;

/** The default fine, per-row tag convention: `collection:{name}:{id}`. */
export const defaultFineTagFor = (collection: string, id: string): string =>
  `${defaultTagFor(collection)}:${id}`;

/**
 * The fine-tag row budget: a response enumerating more rows than this is
 * tagged coarse-only (see {@link tagsFor}) rather than carrying one fine tag
 * per row — a document listing thousands of rows cannot carry thousands of
 * tags on a bounded header.
 *
 * Derived against the real ceiling on the header this convention rides on —
 * `x-legation-cache-meta` (`CacheApiHttpCache.metaHeader`), which carries
 * `encodeURIComponent(JSON.stringify(meta))` and so must fit under Node's
 * default `--max-http-header-size` of 16 KiB (16384 bytes) once responses are
 * served through `@thomasfosterau/legation-node`:
 *
 * - `encodeURIComponent` expands every byte outside its unreserved set to
 *   `%XX` (3 bytes), so 3x the raw byte length is a safe upper bound on
 *   encoded size regardless of which characters a collection name or row id
 *   use.
 * - Reserve 4096 bytes (16 KiB / 4) for the rest of `CachedResponseMeta` —
 *   `url`, three numeric timestamps, the coarse tag, and JSON's own
 *   braces/keys/quotes — leaving `16384 - 4096 = 12288` bytes for fine tags.
 * - One fine tag, worst case: a JSON array entry `"collection:{name}:{id}",`
 *   with a 40-char collection name and a 40-char row id (a UUIDv4 is 36
 *   chars) is `2 (quotes) + 11 ("collection:") + 40 + 1 (":") + 40 + 1 (",")
 *   = 95` raw bytes, i.e. at most `95 * 3 = 285` encoded bytes.
 * - `N = floor(12288 / 285) = 43`.
 */
export const FINE_TAG_ROW_BUDGET = 43;

/** The collections and individual rows one engine event touched. */
export interface Touched {
  readonly collections: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{ readonly collection: string; readonly id: string }>;
}

const EMPTY_TOUCHED: Touched = { collections: [], rows: [] };

/** What an engine event touched, or nothing for other events. */
const touchedBy = (event: ClientEngine.EngineEvent): Touched => {
  switch (event._tag) {
    case "PullCompleted":
      return { collections: event.collections, rows: event.rows };
    case "ViewRebuilt":
      return { collections: event.collections ?? [], rows: [] };
    default:
      return EMPTY_TOUCHED;
  }
};

/**
 * Derive the change feed from an engine's event stream: the distinct
 * collections and rows each `PullCompleted` (always present) and scoped
 * `ViewRebuilt` (when present) touched, dropping events that touched
 * nothing. Feed the result to {@link invalidateOnChanges}.
 */
export const collectionChanges = (
  events: Stream.Stream<ClientEngine.EngineEvent>
): Stream.Stream<Touched> =>
  events.pipe(
    Stream.map(touchedBy),
    Stream.filter(
      (touched) =>
        Arr.isReadonlyArrayNonEmpty(touched.collections) ||
        Arr.isReadonlyArrayNonEmpty(touched.rows)
    )
  );

/** Options for {@link invalidateOnChanges}. */
export interface InvalidateOnChangesOptions {
  readonly store: HttpCache.ResponseCacheStore;
  /** Touched collections/rows per change (e.g. from {@link collectionChanges}). */
  readonly changes: Stream.Stream<Touched>;
  /** Map a collection name to its coarse cache tag; defaults to {@link defaultTagFor}. */
  readonly tagFor?: (collection: string) => string;
  /** Map a row to its fine cache tag; defaults to {@link defaultFineTagFor}. */
  readonly fineTagFor?: (collection: string, id: string) => string;
}

/**
 * Fork a scoped fibre that, per emitted change, evicts every cached response
 * tagged for the touched collections (coarse) **and** the touched rows
 * (fine) — `store.invalidateTags`. Invalidation cost stays proportional to
 * the store's tag enumeration — this scans no more than `invalidateTags`
 * already does. Runs until the scope closes; a store error is logged and
 * swallowed, never fatal to the fibre, so a transient cache failure doesn't
 * stop future invalidations.
 */
export const invalidateOnChanges = (
  options: InvalidateOnChangesOptions
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const tagFor = options.tagFor ?? defaultTagFor;
    const fineTagFor = options.fineTagFor ?? defaultFineTagFor;
    yield* Effect.forkScoped(
      Stream.runForEach(options.changes, (touched) => {
        // Evict the union of the coarse and fine tags. The coarse eviction
        // is NOT redundant with the fine one, even though every touched
        // row's collection is already in `touched.collections`: a cached
        // *aggregate* document (a list, an index page, sitemap.xml) can be
        // staled by a row it does not yet contain — a newly-published row
        // has no prior fine tag on that document to match, so only the
        // coarse `collection:{name}` tag reaches it. Dropping the coarse
        // eviction here (it looks redundant next to the fine one above it)
        // would let such aggregates serve stale content indefinitely. Do
        // not optimise it away.
        const tags = new Set<string>();
        for (const collection of touched.collections) tags.add(tagFor(collection));
        for (const row of touched.rows) tags.add(fineTagFor(row.collection, row.id));
        return tags.size === 0
          ? Effect.void
          : options.store
              .invalidateTags([...tags])
              .pipe(
                Effect.catch((error) => Effect.logWarning("HTTP cache invalidation failed", error))
              );
      })
    );
  });

// ─── Response tagging ────────────────────────────────────────────────────────

/** Options for {@link tagsFor}. */
export interface TagsForOptions {
  /** Map a collection name to its coarse cache tag; defaults to {@link defaultTagFor}. */
  readonly tagFor?: (collection: string) => string;
  /** Map a row to its fine cache tag; defaults to {@link defaultFineTagFor}. */
  readonly fineTagFor?: (collection: string, id: string) => string;
}

/** What {@link tagsFor} returns. */
export interface TagsForResult {
  /** The tags to attach to the response (`HttpCachePolicy.tags`). */
  readonly tags: ReadonlyArray<string>;
  /**
   * `true` when `rowIds.length` exceeded {@link FINE_TAG_ROW_BUDGET}, so
   * `tags` carries the coarse tag only rather than one fine tag per row.
   */
  readonly budgetExceeded: boolean;
}

/**
 * Build the cache tags for a response that enumerates `rowIds` of
 * `collection`: the coarse tag, plus one fine tag per row when the row count
 * is within {@link FINE_TAG_ROW_BUDGET} — beyond it, the coarse tag alone
 * (`budgetExceeded: true`), since a fine tag per row would blow the header
 * budget the tag rides on. Pure and synchronous, for use building
 * `HttpCachePolicy.tags`; pair with {@link tagsForObserved} to also record
 * the fallback when it happens.
 */
export const tagsFor = (
  collection: string,
  rowIds: ReadonlyArray<string>,
  options: TagsForOptions = {}
): TagsForResult => {
  const tagFor = options.tagFor ?? defaultTagFor;
  const coarse = tagFor(collection);
  if (rowIds.length > FINE_TAG_ROW_BUDGET) {
    return { tags: [coarse], budgetExceeded: true };
  }
  const fineTagFor = options.fineTagFor ?? defaultFineTagFor;
  return {
    tags: [coarse, ...rowIds.map((id) => fineTagFor(collection, id))],
    budgetExceeded: false,
  };
};

/**
 * {@link tagsFor}, plus an observable fallback: a response that exceeded the
 * budget is never silently coarse — it logs a warning and increments
 * `legation_cache_tag_budget_exceeded_total` (`Telemetry.cacheTagBudgetExceededTotal`),
 * following the same "safely degraded, but counted" idiom as the engine's
 * other bounded-hub fallbacks (`legation_hints_dropped_total`,
 * `legation_change_collapses_total`).
 */
export const tagsForObserved = (
  collection: string,
  rowIds: ReadonlyArray<string>,
  options: TagsForOptions = {}
): Effect.Effect<TagsForResult> =>
  Effect.gen(function* () {
    const result = tagsFor(collection, rowIds, options);
    if (result.budgetExceeded) {
      yield* Effect.logWarning(
        `HTTP cache tag budget exceeded for collection "${collection}": ` +
          `${rowIds.length} rows > ${FINE_TAG_ROW_BUDGET}; tagged coarse-only`
      );
      yield* Metric.update(Telemetry.cacheTagBudgetExceededTotal, 1);
    }
    return result;
  });
