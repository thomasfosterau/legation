# @thomasfosterau/effect-sync-cache

Write-through cache engine for **service workers, edge runtimes, and servers**, built on
[`@thomasfosterau/effect-sync-core`](../core) and [Effect](https://effect.website).

This is not a full sync engine — it is the caching layer: read-through / write-through HTTP
and data caching with stale-while-revalidate, tag/prefix invalidation, paginated queries, and
pluggable persistence.

## What's in the box

- **`WriteThroughCache`** — a thin, opinionated wrapper over core's `SyncCache` with a
  cache-engine vocabulary: `get` (read-through), `put` (write-through), `getPaginated` /
  `getNextPage`, `invalidate` / `invalidateTags` / `purge` / `clear`, and an `events` stream.
- **`HttpCache`** — HTTP request/response caching for a service-worker `fetch` handler or an
  edge runtime: derive a cache key from a `Request`, serve cached `Response`s, and invalidate
  on mutations.
- **`KeyValueStoreAdapter`** — a `CacheStore` backed by Effect's `KeyValueStore`, so the cache
  can persist to `localStorage`, the file system, Redis, or SQL.

## The freshness model

`WriteThroughCache` exposes two windows:

- **`swr`** — the stale-while-revalidate window. While inside it, a cached value is served
  without revalidating. Once it elapses the value is _stale_: the next `get` returns it
  immediately and refreshes in the background.
- **`ttl`** — the eviction window. Once it elapses the value is gone and the next `get` blocks
  on a fresh load.

Internally `swr` maps to core's `staleTime` (with `staleWhileRevalidate: true`) and `ttl` maps
to `timeToLive`.

## Service worker quick start

```ts
import { HttpCache, WriteThroughCache } from "@thomasfosterau/effect-sync-cache";
import { MemoryCacheStore, PromiseFacade } from "@thomasfosterau/effect-sync-core";
import { Duration, Effect, Layer } from "effect";

// Build a runtime around the cache, provided by an in-memory store.
const facade = PromiseFacade.make(
  WriteThroughCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()))
);

// Resolve the cache instance once.
const cachePromise = facade.run(Effect.service(WriteThroughCache.WriteThroughCache));

self.addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(
    cachePromise.then((cache) =>
      HttpCache.handleFetchPromise(facade, cache, {
        request: event.request,
        upstream: (request) => Effect.promise(() => fetch(request)),
        swr: Duration.seconds(30),
        ttl: Duration.minutes(10),
      })
    )
  );
});
```

`handleFetch` semantics:

- **GET** (and any method in `cacheableMethods`, default `["GET"]`) is served read-through.
  Only responses that pass `isCacheable` (default: any `2xx`) are persisted; non-cacheable
  responses are returned but never written back.
- **POST / PUT / DELETE** pass straight through to `upstream`, and on a `2xx` response every
  cached entry for the same URL is invalidated.

### Known limitation: binary bodies

`CachedResponse` stores bodies as text (`response.text()`). Binary responses
(`ArrayBuffer` / `Blob`) round-trip through `string` and may be corrupted — use this cache for
text/JSON responses, or extend `CachedResponse` to carry a base64 payload.

## Edge runtime usage

The same `WriteThroughCache` works in an edge handler — drive it through a `PromiseFacade` (or
a `ManagedRuntime`):

```ts
export default async function handler(request: Request): Promise<Response> {
  const cache = await cachePromise;
  return HttpCache.handleFetchPromise(facade, cache, {
    request,
    upstream: (req) => Effect.promise(() => fetch(req)),
    swr: Duration.seconds(15),
  });
}
```

## Data caching and paginated queries

```ts
import { WriteThroughCache } from "@thomasfosterau/effect-sync-cache";
import { Duration, Effect, Option } from "effect";

const program = Effect.gen(function* () {
  const cache = yield* WriteThroughCache.WriteThroughCache;

  // Read-through a single value.
  const user = yield* cache.get({
    key: ["users", "1"],
    loader: fetchUser("1"),
    swr: Duration.minutes(1),
    ttl: Duration.minutes(10),
    tags: ["users"],
  });

  // Paginated query: read the first page, then append more.
  const descriptor = {
    key: ["feed"],
    loadPage: (cursor: Option.Option<string>) => loadFeedPage(cursor),
    staleTime: Duration.minutes(1),
  };
  const firstPage = yield* cache.getPaginated(descriptor);
  const withMore = yield* cache.getNextPage(descriptor);

  // Flatten loaded items and check for more.
  return { user, firstPage, withMore };
});
```

## Persistence via KeyValueStore

Swap the in-memory store for any `KeyValueStore` backend to persist the cache across restarts:

```ts
import { KeyValueStoreAdapter, WriteThroughCache } from "@thomasfosterau/effect-sync-cache";
import { Layer } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

// Browser: persist to localStorage.
const store = KeyValueStoreAdapter.layer.pipe(
  Layer.provide(KeyValueStore.layerStorage(() => localStorage))
);

const cacheLayer = WriteThroughCache.layer.pipe(Layer.provide(store));
```

Other backends: `KeyValueStore.layerFileSystem(dir)`, `KeyValueStore.layerSql()`,
`KeyValueStore.layerMemory`.

### How enumeration works

`KeyValueStore` has no key-listing API, but `CacheStore.entries` must enumerate (and filter)
every entry. The adapter therefore maintains an **index entry**: a JSON array of every stored
key hash, kept under the reserved key `effect-sync-cache:__index__` and updated on every
`set` / `remove` / `clear`. Each entry is stored under `effect-sync-cache:${SyncKey.hash(key)}`.
This keeps the adapter compatible with any backend at the cost of one extra read/write per
mutation.

## License

MIT
