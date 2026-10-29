---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-cloudflare": minor
"@thomasfosterau/legation-browser": patch
---

Server-side cache eviction from committed writes (#206). `InvalidationSink` (on `@thomasfosterau/legation-effect/internal`) subscribes a sink to the `InvalidationBus` and passes it the collections and rows each hint batch touched, on a fibre of its own, so an eviction can neither fail nor delay the write. `EdgeInvalidation` in `@thomasfosterau/legation-cloudflare` provides the sinks: KV deletes of `{collection}:{id}`, Workers cache purges by tag, and `forward` / `receive` to carry an invalidation from the API Worker to the front-door Worker that holds the cache over a service binding's RPC method. Failures, including a purge that resolves `{ success: false }`, are logged. The `collection:{name}` / `collection:{name}:{id}` tag spelling moves to `HttpCache` (`tagFor`, `fineTagFor`, `evictionTags`) in the core; `HttpCacheInvalidation.defaultTagFor`, `defaultFineTagFor` and `Touched` in `@thomasfosterau/legation-browser` now refer to it, unchanged.
