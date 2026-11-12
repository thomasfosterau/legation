---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

**Breaking:** `FanoutShard.make` is now an Effect value, not a function: write `LegationShard.make(FanoutShard.make)` instead of `FanoutShard.make()`. `Room.RoomObject`'s `webSocketMessage` and `webSocketClose` now declare the parameters Alchemy's Durable Object handler signature passes; nothing changes at runtime.
