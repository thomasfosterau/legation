/**
 * Cache API HTTP cache tests: the ResponseCacheStore over a fake Cache API
 * (meta round-trip, foreign entries, tag invalidation) and the
 * stale-while-revalidate fetch handler (fresh serve, stale serve +
 * background refresh, expired reload, passthrough).
 */
import type { HttpCache } from "@thomasfosterau/legation/internal";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { awaitPromise } from "./await-promise.js";
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

      const found = yield* store.match(request);
      const hit = yield* Effect.fromOption(found);
      expect(hit.meta.tags).toEqual(["todos"]);
      expect(yield* awaitPromise(() => hit.response.json())).toEqual([{ id: "1" }]);
    })
  );

  it.effect("entries without our metadata header are a miss", () =>
    Effect.gen(function* () {
      const cache = makeFakeCache();
      const store = CacheApiHttpCache.make(cache);
      const request = new Request("https://api.test/foreign");
      cache.entries.set(request.url, new Response("foreign"));
      expect(Option.isNone(yield* store.match(request))).toBe(true);
      cache.entries.set(
        request.url,
        new Response("corrupt", { headers: { [CacheApiHttpCache.metaHeader]: "%7Bnot-json" } })
      );
      expect(Option.isNone(yield* store.match(request))).toBe(true);
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
      expect(Option.isNone(yield* store.match(todos))).toBe(true);
      expect(Option.isSome(yield* store.match(users))).toBe(true);
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
        policy: () => Option.some({ staleTime: "1 hour" }),
      });
      const request = new Request("https://api.test/todos");

      const first = yield* handler(request);
      expect(yield* awaitPromise(() => first.response.text())).toBe("network-1");
      expect(Option.isNone(first.revalidate)).toBe(true);

      const second = yield* handler(request);
      expect(yield* awaitPromise(() => second.response.text())).toBe("network-1");
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
        policy: () => Option.some({ staleTime: 0 }),
      });
      const request = new Request("https://api.test/todos");
      yield* handler(request);

      const stale = yield* handler(request);
      expect(yield* awaitPromise(() => stale.response.text())).toBe("network-1");
      const revalidate = yield* Effect.fromOption(stale.revalidate);
      yield* revalidate;
      expect(network.calls()).toBe(2);

      // The background refresh replaced the stored copy.
      const refreshed = yield* handler(request);
      expect(yield* awaitPromise(() => refreshed.response.text())).toBe("network-2");
    })
  );

  it.effect("expired entries reload from the network", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: network.fetch,
        policy: () => Option.some({ staleTime: 0, timeToLive: 0 }),
      });
      const request = new Request("https://api.test/todos");
      yield* handler(request);

      const reloaded = yield* handler(request);
      expect(yield* awaitPromise(() => reloaded.response.text())).toBe("network-2");
      expect(Option.isNone(reloaded.revalidate)).toBe(true);
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
          request.url.endsWith("/cached") ? Option.some({ staleTime: "1 hour" }) : Option.none(),
      });

      yield* handler(new Request("https://api.test/cached", { method: "POST" }));
      yield* handler(new Request("https://api.test/other"));
      yield* handler(new Request("https://api.test/other"));
      expect(network.calls()).toBe(3);
    })
  );

  it.effect("stores only the responses the policy's cacheable accepts", () =>
    Effect.gen(function* () {
      let calls = 0;
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: (request) => {
          calls += 1;
          const cacheControl = request.url.endsWith("/public") ? "public, max-age=60" : "private";
          return Promise.resolve(
            new Response(`network-${calls}`, { headers: { "cache-control": cacheControl } })
          );
        },
        policy: () =>
          Option.some({
            staleTime: "1 hour",
            cacheable: (response: Response) => response.ok && CacheApiHttpCache.isPublic(response),
          }),
      });

      yield* handler(new Request("https://api.test/private"));
      yield* handler(new Request("https://api.test/private"));
      expect(calls).toBe(2);

      yield* handler(new Request("https://api.test/public"));
      const second = yield* handler(new Request("https://api.test/public"));
      expect(yield* awaitPromise(() => second.response.text())).toBe("network-3");
      expect(calls).toBe(3);
    })
  );

  it.effect("does not store non-ok responses by default", () =>
    Effect.gen(function* () {
      let calls = 0;
      const handler = CacheApiHttpCache.fetchHandler({
        store: CacheApiHttpCache.make(makeFakeCache()),
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("missing", { status: 404 }));
        },
        policy: () => Option.some({ staleTime: "1 hour" }),
      });
      yield* handler(new Request("https://api.test/missing"));
      yield* handler(new Request("https://api.test/missing"));
      expect(calls).toBe(2);
    })
  );
});

const withCacheControl = (value: string) =>
  CacheApiHttpCache.isPublic(new Response("", { headers: { "cache-control": value } }));

describe("isPublic", () => {
  it("reads the public directive from Cache-Control", () => {
    expect(withCacheControl("public, max-age=60")).toBe(true);
    expect(withCacheControl("max-age=60, PUBLIC")).toBe(true);
    expect(withCacheControl("private, max-age=60")).toBe(false);
    expect(withCacheControl("no-public")).toBe(false);
    expect(CacheApiHttpCache.isPublic(new Response(""))).toBe(false);
  });
});
