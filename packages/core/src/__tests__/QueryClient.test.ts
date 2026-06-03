import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Query from "../Query.js";
import * as SyncKey from "../SyncKey.js";
import { CacheStore } from "../CacheStore.js";
import * as QueryClient from "../QueryClient.js";

const testLayer = QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withClient = <A, E>(
  program: (
    client: QueryClient.QueryClient
  ) => Effect.Effect<A, E, QueryClient.QueryClient | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(QueryClient.QueryClient), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

describe("QueryClient", () => {
  it("fetches and caches", async () => {
    const result = await withClient((client) =>
      Effect.gen(function* () {
        const counter = yield* Ref.make(0);
        const descriptor = Query.make({
          key: ["users", "1"],
          loader: Ref.updateAndGet(counter, (n) => n + 1),
          staleTime: Duration.minutes(5),
        });
        const first = yield* client.fetch(descriptor);
        const second = yield* client.fetch(descriptor);
        const runs = yield* Ref.get(counter);
        return { first, second, runs };
      })
    );
    expect(result.first).toBe(1);
    expect(result.second).toBe(1);
    expect(result.runs).toBe(1);
  });

  it("refetch forces a fresh load", async () => {
    const result = await withClient((client) =>
      Effect.gen(function* () {
        const counter = yield* Ref.make(0);
        const descriptor = Query.make({
          key: ["users", "1"],
          loader: Ref.updateAndGet(counter, (n) => n + 1),
          staleTime: Duration.minutes(5),
        });
        yield* client.fetch(descriptor);
        return yield* client.refetch(descriptor);
      })
    );
    expect(result).toBe(2);
  });

  it("getQueryData / setQueryData round-trip", async () => {
    const result = await withClient((client) =>
      Effect.gen(function* () {
        yield* client.setQueryData(["users", "1"], { name: "Ada" });
        return yield* client.getQueryData<{ name: string }>(["users", "1"]);
      })
    );
    expect(Option.getOrUndefined(result)).toEqual({ name: "Ada" });
  });

  it("prefetch warms the cache and swallows errors", async () => {
    const result = await withClient((client) =>
      Effect.gen(function* () {
        yield* client.prefetch(Query.make({ key: ["x"], loader: Effect.fail("boom" as const) }));
        return yield* client.getQueryData(["x"]);
      })
    );
    expect(Option.isNone(result)).toBe(true);
  });

  describe("observe", () => {
    it("emits loading then success", async () => {
      const states = await withClient((client) =>
        Effect.gen(function* () {
          const descriptor = Query.make({
            key: ["users", "1"],
            loader: Effect.succeed({ name: "Ada" }),
            staleTime: Duration.minutes(5),
          });
          return yield* Stream.runCollect(Stream.take(client.observe(descriptor), 2));
        })
      );
      expect(states).toHaveLength(2);
      expect(states[0]?.status).toBe("loading");
      expect(states[1]?.status).toBe("success");
      expect(Option.getOrUndefined(states[1]?.data ?? Option.none())).toEqual({ name: "Ada" });
    });

    it("emits a failure state when the loader fails", async () => {
      const states = await withClient((client) =>
        Effect.gen(function* () {
          const descriptor = Query.make({
            key: ["fails"],
            loader: Effect.fail("nope" as const),
          });
          return yield* Stream.runCollect(Stream.take(client.observe(descriptor), 2));
        })
      );
      expect(states[1]?.status).toBe("failure");
      expect(Option.getOrUndefined(states[1]?.error ?? Option.none())).toBe("nope");
    });

    it("re-emits success when the cache entry is updated", async () => {
      const states = await withClient((client) =>
        Effect.gen(function* () {
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
          return yield* Fiber.join(fiber);
        })
      );
      expect(states).toHaveLength(3);
      expect(states[2]?.status).toBe("success");
      expect(Option.getOrUndefined(states[2]?.data ?? Option.none())).toEqual({ name: "Grace" });
    });

    it("refetches on invalidate", async () => {
      const result = await withClient((client) =>
        Effect.gen(function* () {
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
          return { states, runs };
        })
      );
      expect(result.states).toHaveLength(3);
      // After invalidate the loader runs again, producing { n: 2 }.
      expect(result.runs).toBe(2);
      expect(Option.getOrUndefined(result.states[2]?.data ?? Option.none())).toEqual({ n: 2 });
    });
  });

  describe("pagination", () => {
    it("fetches first page then next page", async () => {
      const result = await withClient((client) =>
        Effect.gen(function* () {
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
          return { firstPages: first.pages.length, secondPages: second.pages.length };
        })
      );
      expect(result.firstPages).toBe(1);
      expect(result.secondPages).toBe(2);
    });
  });

  describe("mutate", () => {
    it("applies optimistic update and invalidates", async () => {
      const result = await withClient((client) =>
        Effect.gen(function* () {
          yield* client.setQueryData(["users", "1"], { name: "Ada" });
          const value = yield* client.mutate(
            {
              key: ["mutations", "rename"],
              execute: () => Effect.succeed({ name: "Grace" }),
              optimistic: () => [
                { key: ["users", "1"], update: () => ({ name: "Grace (pending)" }) },
              ],
              updates: (_input, res) => [{ key: ["users", "1"], value: res }],
            },
            undefined
          );
          const cached = yield* client.getQueryData<{ name: string }>(["users", "1"]);
          return { value, cached: Option.getOrUndefined(cached) };
        })
      );
      expect(result.value).toEqual({ name: "Grace" });
      expect(result.cached).toEqual({ name: "Grace" });
    });

    it("rolls back optimistic update on failure", async () => {
      const result = await withClient((client) =>
        Effect.gen(function* () {
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
          return { failed: outcome._tag === "Failure", cached: Option.getOrUndefined(cached) };
        })
      );
      expect(result.failed).toBe(true);
      expect(result.cached).toEqual({ name: "Ada" });
    });
  });
});
