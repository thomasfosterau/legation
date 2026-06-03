import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Ref } from "effect";
import * as HttpCache from "../HttpCache.js";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as WriteThroughCache from "../WriteThroughCache.js";

const testLayer = () => WriteThroughCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("HttpCache", () => {
  describe("requestKey", () => {
    it("derives a key from method and url", () => {
      const key = HttpCache.requestKey({
        url: "https://api.test/users",
        method: "get",
      });
      expect(key).toEqual(["http-cache", "GET", "https://api.test/users"]);
    });

    it("appends vary header values from a Request", () => {
      const request = new Request("https://api.test/users", {
        headers: { Accept: "application/json" },
      });
      const key = HttpCache.requestKey(request, { varyHeaders: ["accept"] });
      expect(key).toEqual(["http-cache", "GET", "https://api.test/users", "application/json"]);
    });
  });

  describe("toCachedResponse / fromCachedResponse", () => {
    it.effect("round-trips status, headers and body", () =>
      Effect.gen(function* () {
        const response = new Response("hello world", {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "text/plain" },
        });

        const cached = yield* HttpCache.toCachedResponse(response);

        expect(cached.status).toBe(201);
        expect(cached.statusText).toBe("Created");
        expect(cached.body).toBe("hello world");
        expect(cached.headers).toContainEqual(["content-type", "text/plain"]);

        // original response is still readable (clone was used)
        expect(yield* Effect.promise(() => response.text())).toBe("hello world");

        const reconstructed = HttpCache.fromCachedResponse(cached);
        expect(reconstructed.status).toBe(201);
        expect(reconstructed.headers.get("content-type")).toBe("text/plain");
        expect(yield* Effect.promise(() => reconstructed.text())).toBe("hello world");
      })
    );
  });

  describe("handleFetch", () => {
    it.effect("caches GET responses so the second call does not hit upstream", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const hits = yield* Ref.make(0);
        const upstream = (_request: Request) =>
          Effect.gen(function* () {
            yield* Ref.update(hits, (n) => n + 1);
            return new Response("payload", { status: 200 });
          });

        const request = new Request("https://api.test/thing");

        const first = yield* HttpCache.handleFetch(cache, {
          request,
          upstream,
          swr: Duration.minutes(5),
        });
        const firstBody = yield* Effect.promise(() => first.text());

        const second = yield* HttpCache.handleFetch(cache, {
          request: new Request("https://api.test/thing"),
          upstream,
          swr: Duration.minutes(5),
        });
        const secondBody = yield* Effect.promise(() => second.text());

        const upstreamHits = yield* Ref.get(hits);

        expect(firstBody).toBe("payload");
        expect(secondBody).toBe("payload");
        expect(upstreamHits).toBe(1);
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("preserves status and headers through the cache", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const upstream = (_request: Request) =>
          Effect.succeed(
            new Response("body", {
              status: 200,
              headers: { "x-custom": "v" },
            })
          );

        const response = yield* HttpCache.handleFetch(cache, {
          request: new Request("https://api.test/headers"),
          upstream,
          swr: Duration.minutes(5),
        });
        const body = yield* Effect.promise(() => response.text());

        expect(response.status).toBe(200);
        expect(response.headers.get("x-custom")).toBe("v");
        expect(body).toBe("body");
      }).pipe(Effect.provide(testLayer()))
    );

    it.effect("does not persist non-2xx responses", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const hits = yield* Ref.make(0);
        const upstream = (_request: Request) =>
          Effect.gen(function* () {
            yield* Ref.update(hits, (n) => n + 1);
            return new Response("missing", { status: 404 });
          });

        const request = new Request("https://api.test/404");
        const first = yield* HttpCache.handleFetch(cache, {
          request,
          upstream,
          swr: Duration.minutes(5),
        });
        const second = yield* HttpCache.handleFetch(cache, {
          request: new Request("https://api.test/404"),
          upstream,
          swr: Duration.minutes(5),
        });
        const upstreamHits = yield* Ref.get(hits);

        expect(first.status).toBe(404);
        expect(second.status).toBe(404);
        // not cached: both calls reached upstream
        expect(upstreamHits).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );

    it.live("passes POST through and invalidates the URL's cached GET", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const getHits = yield* Ref.make(0);
        const getUpstream = (_request: Request) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(getHits, (x) => x + 1);
            return new Response(`get-${n}`, { status: 200 });
          });

        const url = "https://api.test/resource";

        // Prime the GET cache.
        const primed = yield* HttpCache.handleFetch(cache, {
          request: new Request(url),
          upstream: getUpstream,
          swr: Duration.minutes(5),
        });
        const primedBody = yield* Effect.promise(() => primed.text());

        // A POST passes through and invalidates the GET entry.
        const postResponse = yield* HttpCache.handleFetch(cache, {
          request: new Request(url, { method: "POST" }),
          upstream: (_request) => Effect.succeed(new Response("ok", { status: 200 })),
          swr: Duration.minutes(5),
        });
        const postBody = yield* Effect.promise(() => postResponse.text());

        // Next GET serves the stale (now-invalidated) value but
        // revalidates behind it; wait, then read fresh.
        yield* HttpCache.handleFetch(cache, {
          request: new Request(url),
          upstream: getUpstream,
          swr: Duration.minutes(5),
        });
        yield* Effect.sleep(Duration.millis(20));
        const refreshed = yield* HttpCache.handleFetch(cache, {
          request: new Request(url),
          upstream: getUpstream,
          swr: Duration.minutes(5),
        });
        const refreshedBody = yield* Effect.promise(() => refreshed.text());
        const getCount = yield* Ref.get(getHits);

        expect(primedBody).toBe("get-1");
        expect(postBody).toBe("ok");
        // invalidation forced a re-fetch of the GET
        expect(refreshedBody).toBe("get-2");
        expect(getCount).toBe(2);
      }).pipe(Effect.provide(testLayer()))
    );
  });

  describe("handleFetchPromise", () => {
    it.live("runs the fetch handler as a promise via a runner", () =>
      Effect.gen(function* () {
        const cache = yield* WriteThroughCache.WriteThroughCache;
        const runtime = Effect.runPromise;
        // Build a one-off runner backed by a provided cache instance.
        const runner: HttpCache.FetchRunner = {
          run: (effect) => runtime(effect),
        };
        const response = yield* Effect.promise(() =>
          HttpCache.handleFetchPromise(runner, cache, {
            request: new Request("https://api.test/promise"),
            upstream: (_request) => Effect.succeed(new Response("via-promise", { status: 200 })),
            swr: Duration.minutes(5),
          })
        );
        const body = yield* Effect.promise(() => response.text());

        expect(body).toBe("via-promise");
      }).pipe(Effect.provide(testLayer()))
    );
  });
});
