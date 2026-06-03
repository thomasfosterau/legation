import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import type { CacheStore } from "../CacheStore.js";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as SyncCache from "../SyncCache.js";
import * as SyncKey from "../SyncKey.js";

const testLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withCache = <A, E>(
  program: (cache: SyncCache.SyncCache) => Effect.Effect<A, E, SyncCache.SyncCache | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(SyncCache.SyncCache), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

describe("SyncCache", () => {
  describe("read-through", () => {
    it("loads on miss and serves from cache on hit", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          const options = {
            key: ["counters", "a"],
            loader,
            staleTime: Duration.minutes(5),
          };

          const first = yield* cache.read(options);
          const second = yield* cache.read(options);
          const loaderRuns = yield* Ref.get(counter);

          return { first, second, loaderRuns };
        })
      );

      expect(result.first).toBe(1);
      expect(result.second).toBe(1);
      expect(result.loaderRuns).toBe(1);
    });

    it("reloads when the entry is stale", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          // staleTime omitted: entries are stale immediately
          const options = { key: ["counters", "a"], loader };

          const first = yield* cache.read(options);
          const second = yield* cache.read(options);

          return { first, second };
        })
      );

      expect(result.first).toBe(1);
      expect(result.second).toBe(2);
    });

    it("bypasses the cache with forceRefresh", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          const options = {
            key: ["counters", "a"],
            loader,
            staleTime: Duration.minutes(5),
          };

          yield* cache.read(options);
          const refreshed = yield* cache.read({ ...options, forceRefresh: true });

          return refreshed;
        })
      );

      expect(result).toBe(2);
    });

    it("deduplicates concurrent loads of the same key", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(20));
            return yield* Ref.updateAndGet(counter, (n) => n + 1);
          });
          const options = {
            key: ["counters", "shared"],
            loader,
            staleTime: Duration.minutes(5),
          };

          const values = yield* Effect.all(
            [cache.read(options), cache.read(options), cache.read(options)],
            { concurrency: "unbounded" }
          );
          const loaderRuns = yield* Ref.get(counter);

          return { values, loaderRuns };
        })
      );

      expect(result.loaderRuns).toBe(1);
      expect(result.values).toEqual([1, 1, 1]);
    });

    it("propagates loader failures", async () => {
      await expect(
        withCache((cache) =>
          cache.read({
            key: ["failing"],
            loader: Effect.fail("boom" as const),
          })
        )
      ).rejects.toThrow();
    });
  });

  describe("write-through", () => {
    it("persists the writer result", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const written = yield* cache.write({
            key: ["users", "1"],
            writer: Effect.succeed({ name: "Ada" }),
            staleTime: Duration.minutes(5),
          });
          const cached = yield* cache.peek<{ name: string }>(["users", "1"]);
          return { written, cached: Option.getOrUndefined(cached)?.value };
        })
      );

      expect(result.written).toEqual({ name: "Ada" });
      expect(result.cached).toEqual({ name: "Ada" });
    });

    it("applies optimistic values and rolls back on failure", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          // Seed the cache with the "previous" value.
          yield* cache.set(["users", "1"], { name: "Ada" });

          const written = yield* Effect.result(
            cache.write({
              key: ["users", "1"],
              writer: Effect.fail("server rejected" as const),
              optimistic: { name: "Grace" },
            })
          );

          const cached = yield* cache.peek<{ name: string }>(["users", "1"]);
          return {
            failed: written._tag === "Failure",
            cached: Option.getOrUndefined(cached)?.value,
          };
        })
      );

      expect(result.failed).toBe(true);
      expect(result.cached).toEqual({ name: "Ada" });
    });

    it("removes the optimistic entry on failure when nothing was cached before", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          yield* Effect.result(
            cache.write({
              key: ["users", "new"],
              writer: Effect.fail("nope" as const),
              optimistic: { name: "Ghost" },
            })
          );
          return yield* cache.peek(["users", "new"]);
        })
      );

      expect(Option.isNone(result)).toBe(true);
    });
  });

  describe("invalidation", () => {
    it("marks matching entries stale by prefix", async () => {
      const result = await withCache((cache) =>
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const loader = Ref.updateAndGet(counter, (n) => n + 1);
          const options = {
            key: ["users", "1"],
            loader,
            staleTime: Duration.minutes(5),
          };

          yield* cache.read(options);
          yield* cache.invalidate(SyncKey.prefixFilter(["users"]));
          yield* cache.read(options);

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
            staleTime: Duration.minutes(5),
            tags: ["users"],
          };

          yield* cache.read(options);
          yield* cache.invalidateTags(["users"]);
          yield* cache.read(options);

          return yield* Ref.get(counter);
        })
      );

      expect(result).toBe(2);
    });
  });

  describe("events", () => {
    it("publishes Updated and Removed events for writes", async () => {
      const events = await withCache((cache) =>
        Effect.gen(function* () {
          // Subscribe before writing.
          const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(cache.events, 2)));
          yield* Effect.sleep(Duration.millis(10));

          yield* cache.set(["users", "1"], { name: "Ada" });
          yield* cache.remove(["users", "1"]);

          return yield* Fiber.join(fiber);
        })
      );

      expect(events).toHaveLength(2);
      expect(events[0]?._tag).toBe("Updated");
      expect(events[1]?._tag).toBe("Removed");
    });
  });
});
