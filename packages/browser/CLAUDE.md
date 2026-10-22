# packages/browser — `@thomasfosterau/legation-browser`

Browser-runtime adapters. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Everything that touches browser globals (`WebSocket`, `indexedDB`, `BroadcastChannel`, `navigator`, the Cache API, service-worker and Background Sync APIs) lives here, never in `packages/effect` (ADR-0006). Imports from the workspace: `@thomasfosterau/legation-effect` only.
- Peers: `effect`, `@effect/platform-browser` (both `catalog:peers`).
- One entry (`src/index.ts`); `src/internal/` is private implementation, not exported.

## Invariants

- **The service-worker-hosted engine is the recommended topology** (ADR-0010); tabs are mirrors over `BroadcastChannel`, and the elected main-thread host is the fallback. A mirror never owns a store.
- **The IndexedDB store is the durable `ClientStore`**: its object-store layout is a storage format other sessions read (see `docs/indexeddb-native-store.md`); change it only with a migration.

## Tests

`src/__tests__/` (Vitest project `node`, over `fake-indexeddb` and in-memory channels); `native-store.bench.ts` is a benchmark (`vp run bench`).
