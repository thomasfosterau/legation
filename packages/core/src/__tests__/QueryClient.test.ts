import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Query from "../Query.js";
import * as QueryClient from "../QueryClient.js";
import * as SyncKey from "../SyncKey.js";

const testLayer = () => QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("QueryClient", () => {
  it.effect("fetches and caches", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      const counter = yield* Ref.make(0);
      const descriptor = Query.make({
        key: ["users", "1"],
        loader: Ref.updateAndGet(counter, (n) => n + 1),
        staleTime: Duration.minutes(5),
      });
      const first = yield* client.fetch(descriptor);
      const second = yield* client.fetch(descriptor);
      const runs = yield* Ref.get(counter);

      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(runs).toBe(1);
    }).pipe(Effect.provide(testLayer())));

  it.effect("refetch forces a fresh load", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      const counter = yield* Ref.make(0);
      const descriptor = Query.make({
        key: ["users", "1"],
        loader: Ref.updateAndGet(counter, (n) => n + 1),
        staleTime: Duration.minutes(5),
      });
      yield* client.fetch(descriptor);
      const result = yield* client.refetch(descriptor);

      expect(result).toBe(2);
    }).pipe(Effect.provide(testLayer())));

  it.effect("getQueryData / setQueryData round-trip", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      yield* client.setQueryData(["users", "1"], { name: "Ada" });
      const result = yield* client.getQueryData<{ name: string }>(["users", "1"]);

      expect(Option.getOrUndefined(result)).toEqual({ name: "Ada" });
    }).pipe(Effect.provide(testLayer())));

  it.effect("prefetch warms the cache and swallows errors", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      yield* client.prefetch(Query.make({ key: ["x"], loader: Effect.fail("boom" as const) }));
      const result = yield* client.getQueryData(["x"]);

      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(testLayer())));

  describe("observe", () => {
    it.effect("emits loading then success", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        const descriptor = Query.make({
          key: ["users", "1"],
          loader: Effect.succeed({ name: "Ada" }),
          staleTime: Duration.minutes(5),
        });
        const states = yield* Stream.runCollect(Stream.take(client.observe(descriptor), 2));

        expect(states).toHaveLength(2);
        expect(states[0]?.status).toBe("loading");
        expect(states[1]?.status).toBe("success");
        expect(Option.getOrUndefined(states[1]?.data ?? Option.none())).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer())));

    it.effect("emits a failure state when the loader fails", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        const descriptor = Query.make({
          key: ["fails"],
          loader: Effect.fail("nope" as const),
        });
        const states = yield* Stream.runCollect(Stream.take(client.observe(descriptor), 2));

        expect(states[1]?.status).toBe("failure");
        expect(Option.getOrUndefined(states[1]?.error ?? Option.none())).toBe("nope");
      }).pipe(Effect.provide(testLayer())));

    it.live("re-emits success when the cache entry is updated", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        const descriptor = Query.make({
          key: ["users", "1"],
          loader: Effect.succeed({ name: "Ada" }),
          staleTime: Duration.minutes(5),
        });
        // Collect loading, success, then one live update.
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(client.observe(descriptor), 3))
        );
        yield* Effect.sleep(Duration.millis(30));
        yield* client.setQueryData(["users", "1"], { name: "Grace" });
        const states = yield* Fiber.join(fiber);

        expect(states).toHaveLength(3);
        expect(states[2]?.status).toBe("success");
        expect(Option.getOrUndefined(states[2]?.data ?? Option.none())).toEqual({ name: "Grace" });
      }).pipe(Effect.provide(testLayer())));

    it.live("refetches on invalidate", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        const counter = yield* Ref.make(0);
        const descriptor = Query.make({
          key: ["users", "1"],
          loader: Effect.map(
            Ref.updateAndGet(counter, (n) => n + 1),
            (n) => ({ n })
          ),
          staleTime: Duration.minutes(5),
        });
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(client.observe(descriptor), 3))
        );
        yield* Effect.sleep(Duration.millis(30));
        yield* client.invalidate(SyncKey.prefixFilter(["users"]));
        const states = yield* Fiber.join(fiber);
        const runs = yield* Ref.get(counter);

        expect(states).toHaveLength(3);
        // After invalidate the loader runs again, producing { n: 2 }.
        expect(runs).toBe(2);
        expect(Option.getOrUndefined(states[2]?.data ?? Option.none())).toEqual({ n: 2 });
      }).pipe(Effect.provide(testLayer())));
  });

  describe("pagination", () => {
    it.effect("fetches first page then next page", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        const descriptor = {
          key: ["feed"],
          staleTime: Duration.minutes(5),
          loadPage: (cursor: Option.Option<number>) => {
            const start = Option.getOrElse(cursor, () => 0);
            return Effect.succeed({
              items: [start, start + 1],
              cursor,
              nextCursor: start < 2 ? Option.some(start + 2) : Option.none<number>(),
            });
          },
        };
        const first = yield* client.fetchPaginated(descriptor);
        const second = yield* client.fetchNextPage(descriptor);

        expect(first.pages.length).toBe(1);
        expect(second.pages.length).toBe(2);
      }).pipe(Effect.provide(testLayer())));
  });

  describe("mutate", () => {
    it.effect("applies optimistic update and invalidates", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        yield* client.setQueryData(["users", "1"], { name: "Ada" });
        const value = yield* client.mutate(
          {
            key: ["mutations", "rename"],
            execute: () => Effect.succeed({ name: "Grace" }),
            optimistic: () => [{ key: ["users", "1"], update: () => ({ name: "Grace (pending)" }) }],
            updates: (_input, res) => [{ key: ["users", "1"], value: res }],
          },
          undefined
        );
        const cached = yield* client.getQueryData<{ name: string }>(["users", "1"]);

        expect(value).toEqual({ name: "Grace" });
        expect(Option.getOrUndefined(cached)).toEqual({ name: "Grace" });
      }).pipe(Effect.provide(testLayer())));

    it.effect("rolls back optimistic update on failure", () =>
      Effect.gen(function* () {
        const client = yield* QueryClient.QueryClient;
        yield* client.setQueryData(["users", "1"], { name: "Ada" });
        const outcome = yield* Effect.result(
          client.mutate(
            {
              key: ["mutations", "rename"],
              execute: () => Effect.fail("server rejected" as const),
              optimistic: () => [{ key: ["users", "1"], update: () => ({ name: "Grace" }) }],
            },
            undefined
          )
        );
        const cached = yield* client.getQueryData<{ name: string }>(["users", "1"]);

        expect(outcome._tag === "Failure").toBe(true);
        expect(Option.getOrUndefined(cached)).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(testLayer())));
  });
});
