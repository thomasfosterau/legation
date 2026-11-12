---
"@thomasfosterau/legation": minor
---

`HttpCache` (on `./internal`) follows the Option conventions, and `dist/` is emitted one module per source module, so a bundler drops every module an app doesn't reach: the error classes no longer share a chunk with the whole MemoryBackend graph (#678).

Breaking, in `HttpCache`:

- `ResponseCacheStore.match` answers `Option<CachedResponse>` (the new `CachedResponse` interface) instead of the hit or `undefined`.
- `CachedResponseMeta` is a schema (`HttpCache.CachedResponseMeta`) as well as its type; `expiresAt` is optional rather than a required `number | undefined`.
- `HttpCachePolicy`'s `timeToLive` and `tags` no longer accept an explicit `undefined`; omit them instead.

New: `HttpCachePolicy.cacheable(response)` decides whether a network response is stored (by default `response.ok`).
