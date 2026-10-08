---
"@thomasfosterau/legation-node": patch
---

Under Bun, a normal `/sync-ws` WebSocket close logged `Stream is already ended`
and answered a 500 when the server used `@effect/platform-node` 4.0.0. That
release writes a response onto an upgraded socket that Bun has already ended.
`@effect/platform-node` 4.0.2 returns `101` for a successful upgrade and writes
no response, so the close is no longer an error. Install `effect` and
`@effect/platform-node` 4.0.2 or later together to get the fix. Node was never
affected.
