---
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-node": minor
---

Add runtime-specific adapter packages:

- `@thomasfosterau/legation-browser` — WebSocket client transport (`ClientTransport` over the browser `WebSocket` global) and IndexedDB-backed `CacheStore` persistence for offline-first apps.
- `@thomasfosterau/legation-node` — WebSocket server transport: accepts WebSocket connections (via `ws`) and exposes each as a `ServerConnection` ready to hand to the core `SyncHub`.
