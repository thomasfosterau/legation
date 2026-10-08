---
"@thomasfosterau/legation-node": minor
---

Raise the Effect floor of `@thomasfosterau/legation-node` to 4.0.2: its `effect`
and `@effect/platform-node` peers move from `>=4.0.0-rc.118` to `>=4.0.2`. Install
`effect` and `@effect/platform-node` at 4.0.2 or later together.

Under Bun, a normal `/sync-ws` WebSocket close logged `Stream is already ended`
and answered a 500 on the upgraded connection. That came from
`@effect/platform-node` 4.0.0, which writes a response onto an upgraded socket
that Bun has already ended. `@effect/platform-node` 4.0.2 returns `101` for a
successful upgrade and does not write a response, so the close is no longer
logged as an error. Node was never affected.
