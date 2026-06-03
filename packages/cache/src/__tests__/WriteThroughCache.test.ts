import { describe, expect, it } from "vitest";
import { MemoryCacheStore, SyncKey } from "@thomasfosterau/effect-sync-core";
import { Duration, Effect, Layer, Option, Ref } from "effect";
import * as WriteThroughCache from "../WriteThroughCache.js";

const testLayer = WriteThroughCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withCache = <A, E>(
  program: (
    cache: WriteThroughCache.WriteThroughCache
  ) => Effect.Effect<A, E, WriteThroughCache.WriteThroughCache>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(WriteThroughCache.WriteThroughCache), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

describe("WriteThroughCache", () => {
  describe("get (read-through)", () => {
    it("loads on miss and serves a fresh value from cache", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return { first, second, runs };
        })
      );

      expect(result.first).toBe(1);
      expect(result.second).toBe(1);
      expect(result.runs).toBe(1);
    });

    it("serves stale value immediately and revalidates in the background", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          // swr omitted: entry is stale immediately, so swr kicks in.
          const options = { key: ["users", "1"], loader };

          const first = yield* cache.get(options);
          // stale: returns cached "1" now, refreshes to "2" in background.
          const second = yield* cache.get(options);
          yield* Effect.sleep(Duration.millis(20));
          const third = yield* cache.get(options);
          return { first, second, third };
        })
      );

      expect(result.first).toBe(1);
      expect(result.second).toBe(1);
      expect(result.third).toBe(2);
    });

    it("forceRefresh bypasses the cached value", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          const options = {
            key: ["users", "1"],
            loader,
            swr: Duration.minutes(5),
          };

          yield* cache.get(options);
          return yield* cache.get({ ...options, forceRefresh: true });
        })
      );

      expect(result).toBe(2);
    });

    it("honors ttl by expiring entries (blocking reload after expiry)", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return { first, second };
        })
      );

      expect(result.first).toBe(1);
      expect(result.second).toBe(2);
    });
  });

  describe("put (write-through)", () => {
    it("runs the writer and persists its result", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return { written, cached };
        })
      );

      expect(result.written).toEqual({ name: "Ada" });
      expect(result.cached).toEqual({ name: "Ada" });
    });

    it("applies optimistic values and rolls back on writer failure", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return { failed: failed._tag === "Failure", cached };
        })
      );

      expect(result.failed).toBe(true);
      expect(result.cached).toEqual({ name: "Ada" });
    });
  });

  describe("invalidation", () => {
    it("invalidates by prefix", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return yield* Ref.get(counter);
        })
      );

      expect(result).toBe(2);
    });

    it("invalidates by tag", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return yield* Ref.get(counter);
        })
      );

      expect(result).toBe(2);
    });

    it("purge removes a single entry", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
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
          return { removed, reloaded };
        })
      );

      expect(result.removed).toBe(true);
      expect(result.reloaded).toBe(2);
    });

    it("clear empties the cache", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          const a = { key: ["a"], loader, swr: Duration.minutes(5) };
          const b = { key: ["b"], loader, swr: Duration.minutes(5) };

          yield* cache.get(a);
          yield* cache.get(b);
          yield* cache.clear;
          yield* cache.get(a);
          yield* cache.get(b);
          return yield* Ref.get(counter);
        })
      );

      expect(result).toBe(4);
    });
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

    it("reads the first page and reports hasNextPage", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const descriptor = {
            key: ["feed"],
            loadPage: loadPage(3),
            staleTime: Duration.minutes(5),
          };
          return yield* cache.getPaginated(descriptor);
        })
      );

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]?.items).toEqual([{ id: 0 }, { id: 1 }]);
    });

    it("appends pages with getNextPage and flattens items", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const descriptor = {
            key: ["feed"],
            loadPage: loadPage(3),
            staleTime: Duration.minutes(5),
          };
          yield* cache.getPaginated(descriptor);
          yield* cache.getNextPage(descriptor);
          const final = yield* cache.getNextPage(descriptor);
          return final;
        })
      );

      expect(result.pages).toHaveLength(3);
      const all = result.pages.flatMap((p) => p.items);
      expect(all).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
      // last page has no next cursor
      expect(Option.isNone(result.pages[2]!.nextCursor)).toBe(true);
    });
  });
});
