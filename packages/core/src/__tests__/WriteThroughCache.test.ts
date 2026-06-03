import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Ref } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as SyncKey from "../SyncKey.js";
import * as WriteThroughCache from "../WriteThroughCache.js";

const testLayer = () => WriteThroughCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("WriteThroughCache", () => {
  describe("get (read-through)", () => {
    it.effect("loads on miss and serves a fresh value from cache", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.minutes(5),
        };

        const first = yield* cache.get(options);
        const second = yield* cache.get(options);
        const runs = yield* Ref.get(counter);

        expect(first).toBe(1);
        expect(second).toBe(1);
        expect(runs).toBe(1);
      }).pipe(Effect.provide(testLayer()))
    );

    it.live("serves stale value immediately and revalidates in the background", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        // swr omitted: entry is stale immediately, so swr kicks in.
        const options = { key: ["users", "1"], loader };

        const first = yield* cache.get(options);
        // stale: returns cached "1" now, refreshes to "2" in background.
        const second = yield* cache.get(options);
        yield* Effect.sleep(Duration.millis(20));
        const third = yield* cache.get(options);

        expect(first).toBe(1);
        expect(second).toBe(1);
        expect(third).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("forceRefresh bypasses the cached value", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.minutes(5),
        };

        yield* cache.get(options);
        const result = yield* cache.get({ ...options, forceRefresh: true });

        expect(result).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.live("honors ttl by expiring entries (blocking reload after expiry)", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.millis(5),
          ttl: Duration.millis(10),
        };

        const first = yield* cache.get(options);
        yield* Effect.sleep(Duration.millis(25));
        const second = yield* cache.get(options);

        expect(first).toBe(1);
        expect(second).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("put (write-through)", () => {
    it.effect("runs the writer and persists its result", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const written = yield* cache.put({
          key: ["users", "1"],
          writer: Effect.succeed({ name: "Ada" }),
          swr: Duration.minutes(5),
        });
        const cached = yield* cache.get({
          key: ["users", "1"],
          loader: Effect.succeed({ name: "stale" }),
          swr: Duration.minutes(5),
        });

        expect(written).toEqual({ name: "Ada" });
        expect(cached).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("applies optimistic values and rolls back on writer failure", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        yield* cache.put({
          key: ["users", "1"],
          writer: Effect.succeed({ name: "Ada" }),
          swr: Duration.minutes(5),
        });

        const failed = yield* Effect.result(
          cache.put({
            key: ["users", "1"],
            writer: Effect.fail("rejected" as const),
            optimistic: { name: "Grace" },
          })
        );

        const cached = yield* cache.get({
          key: ["users", "1"],
          loader: Effect.succeed({ name: "stale" }),
          swr: Duration.minutes(5),
        });

        expect(failed._tag === "Failure").toBe(true);
        expect(cached).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("invalidation", () => {
    it.live("invalidates by prefix", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.minutes(5),
        };

        yield* cache.get(options);
        yield* cache.invalidate(SyncKey.prefixFilter(["users"]));
        // stale now (invalidated): swr serves cached, refreshes behind.
        yield* cache.get(options);
        yield* Effect.sleep(Duration.millis(20));
        yield* cache.get(options);

        expect(yield* Ref.get(counter)).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.live("invalidates by tag", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.minutes(5),
          tags: ["users"],
        };

        yield* cache.get(options);
        yield* cache.invalidateTags(["users"]);
        yield* cache.get(options);
        yield* Effect.sleep(Duration.millis(20));
        yield* cache.get(options);

        expect(yield* Ref.get(counter)).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("purge removes a single entry", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["users", "1"],
          loader,
          swr: Duration.minutes(5),
        };

        yield* cache.get(options);
        const removed = yield* cache.purge(["users", "1"]);
        const reloaded = yield* cache.get(options);

        expect(removed).toBe(true);
        expect(reloaded).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("clear empties the cache", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const a = { key: ["a"], loader, swr: Duration.minutes(5) };
        const b = { key: ["b"], loader, swr: Duration.minutes(5) };

        yield* cache.get(a);
        yield* cache.get(b);
        yield* cache.clear;
        yield* cache.get(a);
        yield* cache.get(b);

        expect(yield* Ref.get(counter)).toBe(4);
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("pagination", () => {
    interface Item {
      readonly id: number;
    }

    const loadPage =
      (totalPages: number) =>
      (
        cursor: Option.Option<number>
      ): Effect.Effect<{
        readonly items: ReadonlyArray<Item>;
        readonly cursor: Option.Option<number>;
        readonly nextCursor: Option.Option<number>;
      }> =>
        Effect.sync(() => {
          const page = Option.getOrElse(cursor, () => 0);
          const items = [{ id: page * 2 }, { id: page * 2 + 1 }];
          const nextCursor = page + 1 < totalPages ? Option.some(page + 1) : Option.none<number>();
          return { items, cursor, nextCursor };
        });

    it.effect("reads the first page and reports hasNextPage", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const descriptor = {
          key: ["feed"],
          loadPage: loadPage(3),
          staleTime: Duration.minutes(5),
        };
        const result = yield* cache.getPaginated(descriptor);

        expect(result.pages).toHaveLength(1);
        expect(result.pages[0]?.items).toEqual([{ id: 0 }, { id: 1 }]);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("appends pages with getNextPage and flattens items", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const descriptor = {
          key: ["feed"],
          loadPage: loadPage(3),
          staleTime: Duration.minutes(5),
        };
        yield* cache.getPaginated(descriptor);
        yield* cache.getNextPage(descriptor);
        const result = yield* cache.getNextPage(descriptor);

        expect(result.pages).toHaveLength(3);
        const all = result.pages.flatMap((p) => p.items);
        expect(all).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
        // last page has no next cursor
        expect(Option.isNone(result.pages[2]!.nextCursor)).toBe(true);
      }).pipe(Effect.provide(testLayer()))
    );
  });
});
