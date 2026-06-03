import { describe, expect, it } from "vitest";
import { Duration, Effect, Option, Ref } from "effect";
import * as Query from "../Query.js";

describe("Query", () => {
  describe("applyRetry", () => {
    it("returns the loader unchanged when no policy is given", async () => {
      const loader = Effect.succeed(1);
      expect(Query.applyRetry(loader, undefined)).toBe(loader);
    });

    it("returns the loader unchanged for a zero-times policy", async () => {
      const loader = Effect.succeed(1);
      expect(Query.applyRetry(loader, { times: 0 })).toBe(loader);
    });

    it("retries failing loaders up to the policy limit", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0);
          const loader = Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
            if (attempt < 3) {
              return yield* Effect.fail(`attempt ${attempt} failed`);
            }
            return attempt;
          });

          const value = yield* Query.applyRetry(loader, {
            times: 5,
            baseDelay: Duration.millis(1),
            factor: 1,
          });
          const total = yield* Ref.get(attempts);
          return { value, total };
        })
      );

      expect(result.value).toBe(3);
      expect(result.total).toBe(3);
    });

    it("fails after exhausting retries", async () => {
      const result = await Effect.runPromise(
        Effect.result(
          Query.applyRetry(Effect.fail("always"), { times: 2, baseDelay: Duration.millis(1) })
        )
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("toReadOptions", () => {
    it("maps descriptor fields to read options", () => {
      const descriptor = Query.make({
        key: ["users", "1"],
        loader: Effect.succeed("data"),
        staleTime: Duration.minutes(1),
        tags: ["users"],
        staleWhileRevalidate: true,
      });

      const options = Query.toReadOptions(descriptor, { forceRefresh: true });

      expect(options.key).toEqual(["users", "1"]);
      expect(options.tags).toEqual(["users"]);
      expect(options.staleWhileRevalidate).toBe(true);
      expect(options.forceRefresh).toBe(true);
    });
  });

  describe("query state transitions", () => {
    it("starts in the initial state", () => {
      const state = Query.initialState(["users"]);
      expect(state.status).toBe("initial");
      expect(Option.isNone(state.data)).toBe(true);
      expect(state.isStale).toBe(true);
    });

    it("moves through loading to success", () => {
      const initial = Query.initialState<string>(["users"]);
      const loading = Query.toLoading(initial);
      expect(loading.status).toBe("loading");
      expect(loading.isFetching).toBe(true);

      const now = Date.now();
      const success = Query.toSuccess(
        loading,
        {
          key: ["users"],
          value: "data",
          updatedAt: now,
          staleAt: now + 60_000,
          expiresAt: null,
          version: undefined,
          tags: [],
        },
        now
      );
      expect(success.status).toBe("success");
      expect(Option.getOrUndefined(success.data)).toBe("data");
      expect(success.isFetching).toBe(false);
      expect(success.isStale).toBe(false);
    });

    it("keeps existing data on refresh (loading after success)", () => {
      const now = Date.now();
      const success = Query.toSuccess(
        Query.initialState<string>(["users"]),
        {
          key: ["users"],
          value: "data",
          updatedAt: now,
          staleAt: null,
          expiresAt: null,
          version: undefined,
          tags: [],
        },
        now
      );

      const refreshing = Query.toLoading(success);
      expect(refreshing.status).toBe("success");
      expect(Option.getOrUndefined(refreshing.data)).toBe("data");
      expect(refreshing.isFetching).toBe(true);
    });

    it("records failures and staleness", () => {
      const failed = Query.toFailure(Query.initialState<string, string>(["users"]), "boom");
      expect(failed.status).toBe("failure");
      expect(Option.getOrUndefined(failed.error)).toBe("boom");

      const stale = Query.toStale(failed);
      expect(stale.isStale).toBe(true);
    });
  });
});
