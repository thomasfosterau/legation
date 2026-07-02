/**
 * Cache API HTTP cache tests: the ResponseCacheStore over a fake Cache API
 * (meta round-trip, foreign entries, tag invalidation) and the
 * stale-while-revalidate fetch handler (fresh serve, stale serve +
 * background refresh, expired reload, passthrough).
 */
import type { HttpCache } from "@legation/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as CacheApiHttpCache from "../CacheApiHttpCache.js";

/** Minimal in-memory Cache API fake, keyed by request URL. */
const makeFakeCache = (): CacheApiHttpCache.CacheLike & {
  readonly entries: Map<string, Response>;
} => {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: (request) => Promise.resolve(entries.get(request.url)?.clone()),
    put: (request, response) => {
      entries.set(request.url, response);
      return Promise.resolve();
    },
    delete: (request) => Promise.resolve(entries.delete(request.url)),
    keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
  };
};

const meta = (overrides?: Partial<HttpCache.CachedResponseMeta>): HttpCache.CachedResponseMeta => ({
  url: "https://api.test/todos",
  storedAt: 0,
  staleAt: Number.MAX_SAFE_INTEGER,
  expiresAt: undefined,
  tags: [],
  ...overrides,
});

describe("CacheApiHttpCache store", () => {
  it.effect("round-trips a response with its metadata", () =>
    Effect.gen(function* () {
      const store = CacheApiHttpCache.make(makeFakeCache());
      const request = new Request("https://api.test/todos");
      yield* store.put(
        request,
        new Response(JSON.stringify([{ id: "1" }]), { status: 200 }),
        meta({ tags: ["todos"] })
      );

      const hit = yield* store.match(request);
      expect(hit).toBeDefined();
      expect(hit?.meta.tags).toEqual(["todos"]);
      expect(yield* Effect.promise(() => hit!.response.json())).toEqual([{ id: "1" }]);
    })
  );

  it.effect("entries without our metadata header are a miss", () =>
    Effect.gen(function* () {
      const cache = makeFakeCache();
      const store = CacheApiHttpCache.make(cache);
      const request = new Request("https://api.test/foreign");
      cache.entries.set(request.url, new Response("foreign"));
      expect(yield* store.match(request)).toBeUndefined();
    })
  );

  it.effect("invalidateTags deletes exactly the tagged entries", () =>
    Effect.gen(function* () {
      const store = CacheApiHttpCache.make(makeFakeCache());
      const todos = new Request("https://api.test/todos");
      const users = new Request("https://api.test/users");
      yield* store.put(todos, new Response("t"), meta({ url: todos.url, tags: ["todos"] }));
      yield* store.put(users, new Response("u"), meta({ url: users.url, tags: ["users"] }));

      yield* store.invalidateTags(["todos"]);
      expect(yield* store.match(todos)).toBeUndefined();
      expect(yield* store.match(users)).toBeDefined();
    })
  );
});

const makeNetwork = () => {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (_request: Request) => {
      calls += 1;
      return Promise.resolve(new Response(`network-${calls}`, { status: 200 }));
    },
  };
};

describe("fetchHandler (stale-while-revalidate)", () => {
  it.effect("caches the first GET and serves fresh entries from cache", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: network.fetch,
        policy: () => ({ staleTime: "1 hour" }),
      });
      const request = new Request("https://api.test/todos");

      const first = yield* handler(request);
      expect(yield* Effect.promise(() => first.response.text())).toBe("network-1");
      expect(first.revalidate).toBeUndefined();

      const second = yield* handler(request);
      expect(yield* Effect.promise(() => second.response.text())).toBe("network-1");
      expect(network.calls()).toBe(1);
    })
  );

  it.effect("serves stale entries immediately and revalidates in the background", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: network.fetch,
        // staleTime 0: stale immediately; no TTL: never expires.
        policy: () => ({ staleTime: 0 }),
      });
      const request = new Request("https://api.test/todos");
      yield* handler(request);

      const stale = yield* handler(request);
      expect(yield* Effect.promise(() => stale.response.text())).toBe("network-1");
      expect(stale.revalidate).toBeDefined();
      yield* stale.revalidate!;
      expect(network.calls()).toBe(2);

      // The background refresh replaced the stored copy.
      const refreshed = yield* handler(request);
      expect(yield* Effect.promise(() => refreshed.response.text())).toBe("network-2");
    })
  );

  it.effect("expired entries reload from the network", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: network.fetch,
        policy: () => ({ staleTime: 0, timeToLive: 0 }),
      });
      const request = new Request("https://api.test/todos");
      yield* handler(request);

      const reloaded = yield* handler(request);
      expect(yield* Effect.promise(() => reloaded.response.text())).toBe("network-2");
      expect(reloaded.revalidate).toBeUndefined();
      expect(network.calls()).toBe(2);
    })
  );

  it.effect("non-GET requests and unmatched routes pass through", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: network.fetch,
        policy: (request) =>
          request.url.endsWith("/cached") ? { staleTime: "1 hour" } : undefined,
      });

      yield* handler(new Request("https://api.test/cached", { method: "POST" }));
      yield* handler(new Request("https://api.test/other"));
      yield* handler(new Request("https://api.test/other"));
      expect(network.calls()).toBe(3);
    })
  );
});
