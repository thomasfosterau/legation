import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import type { CacheStore } from "../CacheStore.js";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Pagination from "../Pagination.js";
import * as SyncCache from "../SyncCache.js";

const testLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withCache = <A, E>(
  program: (cache: SyncCache.SyncCache) => Effect.Effect<A, E, SyncCache.SyncCache | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(SyncCache.SyncCache), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

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
  it("loads and caches the first page", async () => {
    const result = await withCache((cache) =>
      Pagination.readFirstPage(cache, makeDescriptor(10, 3))
    );

    expect(Pagination.items(result)).toEqual([0, 1, 2]);
    expect(Pagination.hasNextPage(result)).toBe(true);
  });

  it("appends subsequent pages", async () => {
    const result = await withCache((cache) =>
      Effect.gen(function* () {
        const descriptor = makeDescriptor(7, 3);
        yield* Pagination.readFirstPage(cache, descriptor);
        yield* Pagination.fetchNextPage(cache, descriptor);
        return yield* Pagination.fetchNextPage(cache, descriptor);
      })
    );

    expect(Pagination.items(result)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Pagination.hasNextPage(result)).toBe(false);
  });

  it("returns the cached result unchanged when no pages remain", async () => {
    const result = await withCache((cache) =>
      Effect.gen(function* () {
        const descriptor = makeDescriptor(2, 5);
        yield* Pagination.readFirstPage(cache, descriptor);
        return yield* Pagination.fetchNextPage(cache, descriptor);
      })
    );

    expect(Pagination.items(result)).toEqual([0, 1]);
    expect(result.pages).toHaveLength(1);
  });

  it("loads the first page when fetchNextPage is called with an empty cache", async () => {
    const result = await withCache((cache) =>
      Pagination.fetchNextPage(cache, makeDescriptor(5, 2))
    );

    expect(Pagination.items(result)).toEqual([0, 1]);
  });

  it("drops oldest pages beyond maxPages", async () => {
    const result = await withCache((cache) =>
      Effect.gen(function* () {
        const descriptor = { ...makeDescriptor(9, 3), maxPages: 2 };
        yield* Pagination.readFirstPage(cache, descriptor);
        yield* Pagination.fetchNextPage(cache, descriptor);
        return yield* Pagination.fetchNextPage(cache, descriptor);
      })
    );

    expect(result.pages).toHaveLength(2);
    expect(Pagination.items(result)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("refetches all previously loaded pages", async () => {
    const result = await withCache((cache) =>
      Effect.gen(function* () {
        const descriptor = makeDescriptor(10, 3);
        yield* Pagination.readFirstPage(cache, descriptor);
        yield* Pagination.fetchNextPage(cache, descriptor);
        // Refetch should restore both pages from the source.
        return yield* Pagination.refetchAllPages(cache, descriptor);
      })
    );

    expect(result.pages).toHaveLength(2);
    expect(Pagination.items(result)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
