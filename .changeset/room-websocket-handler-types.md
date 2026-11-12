---
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

`Room.RoomObject`'s `webSocketMessage` and `webSocketClose` now declare the parameters Alchemy's Durable Object bridge passes them (the socket and the message, or the socket and the close code, reason and `wasClean` flag), matching the provider's `DurableObjectShape`. The room still ignores them; nothing changes at runtime.
