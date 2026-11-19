---
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

The docs no longer call a room hibernation-friendly. `FanoutBus`'s lease heartbeat keeps a timer pending, so a room Durable Object stays in memory, billed for its duration, until the platform evicts it; `Room.make`'s doc comments and the README now say so.
