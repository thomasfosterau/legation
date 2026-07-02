---
"@legation/browser": minor
"@legation/node": minor
---

Add runtime-specific adapter packages:

- `@legation/browser` — WebSocket client transport (`ClientTransport` over the browser `WebSocket` global) and IndexedDB-backed `CacheStore` persistence for offline-first apps.
- `@legation/node` — WebSocket server transport: accepts WebSocket connections (via `ws`) and exposes each as a `ServerConnection` ready to hand to the core `SyncHub`.
