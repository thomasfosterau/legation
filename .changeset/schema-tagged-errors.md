---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-svelte": patch
---

Every tagged error is now a branded `Schema.TaggedError` rather than a
`Data.TaggedError`: `StoreError`, `TransportError`, `QueryError` and the rest
of the engine's errors, the JSON:API adapter's `SyncError` / `NetworkError` /
`ParseError` / `ApiError` / `ConflictError` / `ResourceBridgeError`, and
`HostNotReady`. Construction, `_tag`, `message` and `Effect.catchTag` are
unchanged; each class now carries a schema and a nominal brand, so a
structurally similar object no longer type-checks as one.
