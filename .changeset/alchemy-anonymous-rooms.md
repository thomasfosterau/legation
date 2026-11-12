---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

Anonymous readers can be sharded over rooms (#679). `Worker.routeSync` takes `anonymousRoomOf`, which routes a caller `roomIdOf` left anonymous to a shared room named under the reserved `Worker.anonymousRoomPrefix` (`Option.none()` keeps the 401), so an anonymous caller never reaches a user's room; a `roomIdOf` id inside that namespace is refused with a 500. `Worker.shardByClientGroup({ shards, cookie? })` spreads anonymous callers over `shards` rooms by a stable hash of their client-group cookie. Without `anonymousRoomOf`, anonymous callers still get a 401.
