import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Pagination from "../Pagination.js";
import * as SyncCache from "../SyncCache.js";

const testLayer = () => SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

/** A fake data source of `total` numbered items served in pages of `pageSize`. */
const makeDescriptor = (
  total: number,
  pageSize: number
): Pagination.PaginatedQueryDescriptor<number, number> => ({
  key: ["numbers"],
  loadPage: (cursor) => {
    const offset = Option.getOrElse(cursor, () => 0);
    const items = Array.from(
      { length: Math.min(pageSize, total - offset) },
      (_, index) => offset + index
    );
    const nextOffset = offset + items.length;
    return Effect.succeed({
      items,
      cursor,
      nextCursor: nextOffset < total ? Option.some(nextOffset) : Option.none(),
    });
  },
});

describe("Pagination", () => {
  it.effect("loads and caches the first page", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const result = yield* Pagination.readFirstPage(cache, makeDescriptor(10, 3));

      expect(Pagination.items(result)).toEqual([0, 1, 2]);
      expect(Pagination.hasNextPage(result)).toBe(true);
    }).pipe(Effect.provide(testLayer())));

  it.effect("appends subsequent pages", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = makeDescriptor(7, 3);
      yield* Pagination.readFirstPage(cache, descriptor);
      yield* Pagination.fetchNextPage(cache, descriptor);
      const result = yield* Pagination.fetchNextPage(cache, descriptor);

      expect(Pagination.items(result)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(Pagination.hasNextPage(result)).toBe(false);
    }).pipe(Effect.provide(testLayer())));

  it.effect("returns the cached result unchanged when no pages remain", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = makeDescriptor(2, 5);
      yield* Pagination.readFirstPage(cache, descriptor);
      const result = yield* Pagination.fetchNextPage(cache, descriptor);

      expect(Pagination.items(result)).toEqual([0, 1]);
      expect(result.pages).toHaveLength(1);
    }).pipe(Effect.provide(testLayer())));

  it.effect("loads the first page when fetchNextPage is called with an empty cache", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const result = yield* Pagination.fetchNextPage(cache, makeDescriptor(5, 2));

      expect(Pagination.items(result)).toEqual([0, 1]);
    }).pipe(Effect.provide(testLayer())));

  it.effect("drops oldest pages beyond maxPages", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = { ...makeDescriptor(9, 3), maxPages: 2 };
      yield* Pagination.readFirstPage(cache, descriptor);
      yield* Pagination.fetchNextPage(cache, descriptor);
      const result = yield* Pagination.fetchNextPage(cache, descriptor);

      expect(result.pages).toHaveLength(2);
      expect(Pagination.items(result)).toEqual([3, 4, 5, 6, 7, 8]);
    }).pipe(Effect.provide(testLayer())));

  it.effect("refetches all previously loaded pages", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = makeDescriptor(10, 3);
      yield* Pagination.readFirstPage(cache, descriptor);
      yield* Pagination.fetchNextPage(cache, descriptor);
      // Refetch should restore both pages from the source.
      const result = yield* Pagination.refetchAllPages(cache, descriptor);

      expect(result.pages).toHaveLength(2);
      expect(Pagination.items(result)).toEqual([0, 1, 2, 3, 4, 5]);
    }).pipe(Effect.provide(testLayer())));
});
