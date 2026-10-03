---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-node": minor
"@thomasfosterau/legation-jsonapi": minor
---

Bump the pinned Effect version from `4.0.0-beta.65` to `4.0.0-beta.75` across all packages.

`@thomasfosterau/legation-browser` now builds its IndexedDB cache store on
`@effect/platform-browser` (`BrowserKeyValueStore.layerIndexedDb` + core's
`KeyValueStoreAdapter`) instead of a hand-rolled IndexedDB wrapper.
`@effect/platform-browser` is a new peer dependency of the browser package, and
`IndexedDbCacheStore.make` is now a scoped resource (requires `Scope`); the
`storeName` option was removed (the underlying object store is managed by
platform-browser).
