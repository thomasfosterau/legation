---
"@thomasfosterau/legation-browser": minor
---

The Cache API HTTP cache has an entry of its own, `@thomasfosterau/legation-browser/http-cache` (#678): `CacheApiHttpCache` and core's `HttpCache`, reaching nothing of the engine, so a service worker that only caches HTTP no longer bundles the sync engine. `CacheApiHttpCache` alone now bundles to about 3.7 KB gzip over the `effect/Schema` its error classes need, down from about 42 KB (from either entry). `dist/` is emitted one module per source module, so a bundler drops every module an app doesn't reach.

Breaking, in `CacheApiHttpCache`:

- `fetchHandler`'s `policy` returns `Option<HttpCachePolicy>` (`Option.none()` bypasses the cache), and `FetchHandlerResult.revalidate` is an `Option` (`Some` when a stale entry was served).
- The store's `match` answers an `Option` (core's `ResponseCacheStore`).
- The stored metadata header is decoded with `HttpCache.CachedResponseMeta`'s schema; an entry whose header doesn't decode is a miss. The header's format is unchanged, so existing entries still match.

New: a policy's `cacheable(response)` decides what is stored (by default `response.ok`), and `CacheApiHttpCache.isPublic(response)` reads `Cache-Control: public`, for routes cached only when the origin marks them public. `fetchHandler` returns the new `FetchHandler` type.
