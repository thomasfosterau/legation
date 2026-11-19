---
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

`Room.make`'s `backend` doc comment says to bind a Hyperdrive configuration with query caching disabled: Hyperdrive caches reads outside a transaction without invalidating them on a write, and the pull's reads run outside one. Hyperdrive's transaction pooling keeps a push atomic.
