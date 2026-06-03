import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as SyncCache from "../SyncCache.js";
import * as SyncKey from "../SyncKey.js";

// A fresh layer per test keeps cache state isolated between tests.
const testLayer = () => SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("SyncCache", () => {
  describe("read-through", () => {
    it.effect("loads on miss and serves from cache on hit", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
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

        expect(first).toBe(1);
        expect(second).toBe(1);
        expect(loaderRuns).toBe(1);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("reloads when the entry is stale", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["counters", "a"],
          loader,
          staleTime: Duration.minutes(5),
        };

        const first = yield* cache.read(options);
        // Advance past the freshness window so the next read re-fetches.
        yield* TestClock.adjust(Duration.minutes(6));
        const second = yield* cache.read(options);

        expect(first).toBe(1);
        expect(second).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("bypasses the cache with forceRefresh", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        const counter = yield* Ref.make(0);
        const loader = Ref.updateAndGet(counter, (n) => n + 1);
        const options = {
          key: ["counters", "a"],
          loader,
          staleTime: Duration.minutes(5),
        };

        yield* cache.read(options);
        const refreshed = yield* cache.read({ ...options, forceRefresh: true });

        expect(refreshed).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.live("deduplicates concurrent loads of the same key", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
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

        expect(loaderRuns).toBe(1);
        expect(values).toEqual([1, 1, 1]);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("propagates loader failures", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        const result = yield* Effect.result(
          cache.read({
            key: ["failing"],
            loader: Effect.fail("boom" as const),
          })
        );

        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("write-through", () => {
    it.effect("persists the writer result", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        const written = yield* cache.write({
          key: ["users", "1"],
          writer: Effect.succeed({ name: "Ada" }),
          staleTime: Duration.minutes(5),
        });
        const cached = yield* cache.peek<{ name: string }>(["users", "1"]);

        expect(written).toEqual({ name: "Ada" });
        expect(Option.getOrUndefined(cached)?.value).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("applies optimistic values and rolls back on failure", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
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

        expect(written._tag === "Failure").toBe(true);
        expect(Option.getOrUndefined(cached)?.value).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("removes the optimistic entry on failure when nothing was cached before", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        yield* Effect.result(
          cache.write({
            key: ["users", "new"],
            writer: Effect.fail("nope" as const),
            optimistic: { name: "Ghost" },
          })
        );
        const result = yield* cache.peek(["users", "new"]);

        expect(Option.isNone(result)).toBe(true);
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("invalidation", () => {
    it.effect("marks matching entries stale by prefix", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
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

        expect(yield* Ref.get(counter)).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("invalidates by tag", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
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

        expect(yield* Ref.get(counter)).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("events", () => {
    it.live("publishes Updated and Removed events for writes", () =>
      Effect.gen(function* () {
        const cache = yield* SyncCache.SyncCache;
        // Subscribe before writing.
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(cache.events, 2)));
        yield* Effect.sleep(Duration.millis(10));

        yield* cache.set(["users", "1"], { name: "Ada" });
        yield* cache.remove(["users", "1"]);

        const events = yield* Fiber.join(fiber);

        expect(events).toHaveLength(2);
        expect(events[0]?._tag).toBe("Updated");
        expect(events[1]?._tag).toBe("Removed");
      }).pipe(Effect.provide(testLayer()))
    );
  });
});
