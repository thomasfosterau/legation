---
"@thomasfosterau/effect-sync-core": minor
"@thomasfosterau/effect-sync-jsonapi": minor
---

Restructure the repository into a monorepo of sync-engine packages, with package boundaries drawn by dependency footprint:

- `@thomasfosterau/effect-sync-core` — the Effect-native sync engine. Everything that needs only a dependency on `effect`: sync keys, cache stores, the write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, a durable offline outbox, the client/server sync protocol, transports, conflict resolution, the TanStack-Query-style client (queries/mutations/subscriptions/offline sync), the service-worker/edge HTTP cache engine with KeyValueStore persistence, the server-side sync hub with fan-out, and promise facades for non-Effect consumers.
- `@thomasfosterau/effect-sync-jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors and query/mutation descriptor builders that plug into the core engine.
