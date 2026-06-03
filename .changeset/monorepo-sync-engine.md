---
"@thomasfosterau/effect-sync-core": minor
"@thomasfosterau/effect-sync-client": minor
"@thomasfosterau/effect-sync-cache": minor
"@thomasfosterau/effect-sync-server": minor
"@thomasfosterau/effect-sync-jsonapi": minor
---

Restructure the repository into a monorepo of sync-engine packages:

- `@thomasfosterau/effect-sync-core` — protocol-agnostic sync and cache primitives: sync keys, cache stores, write-through cache engine, queries, pagination, mutations, offline outbox, conflict resolution, the client/server sync protocol, transports, and a promise facade for non-Effect consumers.
- `@thomasfosterau/effect-sync-client` — client-side query/mutation/subscription manager (TanStack-Query-style) with live server subscriptions and offline outbox draining.
- `@thomasfosterau/effect-sync-cache` — write-through cache engine for service workers, edge runtimes, and servers, with paginated query support and pluggable key-value storage.
- `@thomasfosterau/effect-sync-server` — server-side write-through sync engine that applies mutations to a backing store and fans out updates to subscribed clients.
- `@thomasfosterau/effect-sync-jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors.
