/**
 * Pagination
 *
 * Paginated query support. A `PaginatedQueryDescriptor` describes how to
 * load one page given a cursor; the engine accumulates pages into a
 * `PaginatedResult` stored under a single sync key, so paginated data
 * participates in caching, invalidation, and sync like any other entry.
 *
 * Both cursor-based and offset/page-number pagination fit this model:
 * an offset is just a numeric cursor.
 */

import { Effect, Option } from "effect";
import type { EntryOptions, SyncCache } from "./SyncCache.js";
import type { StoreError } from "./Errors.js";
import type { SyncKey } from "./SyncKey.js";

/**
 * A single loaded page.
 */
export interface Page<A, Cursor> {
  readonly items: ReadonlyArray<A>;
  /** The cursor used to load this page (`None` for the first page). */
  readonly cursor: Option.Option<Cursor>;
  /** The cursor for the next page, or `None` when this is the last page. */
  readonly nextCursor: Option.Option<Cursor>;
}

/**
 * The accumulated pages stored in the cache for a paginated query.
 */
export interface PaginatedResult<A, Cursor> {
  readonly pages: ReadonlyArray<Page<A, Cursor>>;
}

/**
 * Flatten the items of every loaded page.
 */
export const items = <A, Cursor>(result: PaginatedResult<A, Cursor>): ReadonlyArray<A> =>
  result.pages.flatMap((page) => page.items);

/**
 * The cursor for loading the next page, or `None` when exhausted.
 */
export const nextCursor = <A, Cursor>(
  result: PaginatedResult<A, Cursor>
): Option.Option<Cursor> => {
  const last = result.pages[result.pages.length - 1];
  return last === undefined ? Option.none() : last.nextCursor;
};

/**
 * `true` when there are more pages to load.
 */
export const hasNextPage = <A, Cursor>(result: PaginatedResult<A, Cursor>): boolean =>
  Option.isSome(nextCursor(result));

/**
 * Declarative description of a paginated query.
 */
export interface PaginatedQueryDescriptor<A, Cursor, E = never, R = never> extends EntryOptions {
  readonly key: SyncKey;
  /** Load one page. Receives `None` for the first page. */
  readonly loadPage: (cursor: Option.Option<Cursor>) => Effect.Effect<Page<A, Cursor>, E, R>;
  /** Maximum number of pages to retain (oldest pages are dropped first). */
  readonly maxPages?: number | undefined;
}

const emptyResult = <A, Cursor>(): PaginatedResult<A, Cursor> => ({ pages: [] });

const appendPage = <A, Cursor>(
  result: PaginatedResult<A, Cursor>,
  page: Page<A, Cursor>,
  maxPages: number | undefined
): PaginatedResult<A, Cursor> => {
  const pages = [...result.pages, page];
  return {
    pages: maxPages !== undefined && pages.length > maxPages ? pages.slice(-maxPages) : pages,
  };
};

/**
 * Read the first page of a paginated query through the cache.
 *
 * On a cache miss (or stale entry) the first page is loaded and stored as
 * a single-page result. Subsequent pages are appended with
 * `fetchNextPage`.
 */
export const readFirstPage = <A, Cursor, E, R>(
  cache: SyncCache,
  descriptor: PaginatedQueryDescriptor<A, Cursor, E, R>
): Effect.Effect<PaginatedResult<A, Cursor>, E | StoreError, R> =>
  cache.read<PaginatedResult<A, Cursor>, E, R>({
    key: descriptor.key,
    loader: Effect.map(descriptor.loadPage(Option.none()), (page) =>
      appendPage(emptyResult<A, Cursor>(), page, descriptor.maxPages)
    ),
    staleTime: descriptor.staleTime,
    timeToLive: descriptor.timeToLive,
    tags: descriptor.tags,
    version: descriptor.version,
  });

/**
 * Load the next page of an already-cached paginated query and append it
 * to the cached result.
 *
 * When nothing is cached yet, this behaves like `readFirstPage`. When the
 * cached result has no next cursor, the cached result is returned
 * unchanged.
 */
export const fetchNextPage = <A, Cursor, E, R>(
  cache: SyncCache,
  descriptor: PaginatedQueryDescriptor<A, Cursor, E, R>
): Effect.Effect<PaginatedResult<A, Cursor>, E | StoreError, R> =>
  Effect.gen(function* () {
    const cached = yield* cache.peek<PaginatedResult<A, Cursor>>(descriptor.key);

    if (Option.isNone(cached)) {
      return yield* readFirstPage(cache, descriptor);
    }

    const current = cached.value.value;
    const cursor = nextCursor(current);
    if (Option.isNone(cursor)) {
      return current;
    }

    const page = yield* descriptor.loadPage(cursor);
    const next = appendPage(current, page, descriptor.maxPages);
    yield* cache.set(descriptor.key, next, {
      staleTime: descriptor.staleTime,
      timeToLive: descriptor.timeToLive,
      tags: descriptor.tags,
      version: descriptor.version,
    });
    return next;
  });

/**
 * Re-load every cached page from the source, page by page, preserving the
 * pagination depth the user had reached. Used by refetch-after-invalidate.
 */
export const refetchAllPages = <A, Cursor, E, R>(
  cache: SyncCache,
  descriptor: PaginatedQueryDescriptor<A, Cursor, E, R>
): Effect.Effect<PaginatedResult<A, Cursor>, E | StoreError, R> =>
  Effect.gen(function* () {
    const cached = yield* cache.peek<PaginatedResult<A, Cursor>>(descriptor.key);
    const pageCount = Option.isSome(cached) ? Math.max(cached.value.value.pages.length, 1) : 1;

    let result = emptyResult<A, Cursor>();
    let cursor: Option.Option<Cursor> = Option.none();

    for (let index = 0; index < pageCount; index++) {
      const page = yield* descriptor.loadPage(cursor);
      result = appendPage(result, page, descriptor.maxPages);
      cursor = page.nextCursor;
      if (Option.isNone(cursor)) break;
    }

    yield* cache.set(descriptor.key, result, {
      staleTime: descriptor.staleTime,
      timeToLive: descriptor.timeToLive,
      tags: descriptor.tags,
      version: descriptor.version,
    });
    return result;
  });
