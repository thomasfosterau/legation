---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-node": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-svelte": minor
---

Rename the project to **Legation**. Every package moves to the `@legation`
scope: the engine is now `@legation/effect` (formerly
`@thomasfosterau/effect-sync-core`), and the adapters/bindings are
`@legation/browser`, `@legation/node`, `@legation/jsonapi`, `@legation/sql`,
and `@legation/svelte` (formerly `@thomasfosterau/effect-sync-*`).

Runtime identifiers follow the brand, which is **breaking for persisted local
state and dashboards**:

- `Context.Service` identifiers: `@thomasfosterau/effect-sync-core/*` →
  `@legation/effect/*` (and per-package equivalents)
- Client-store key prefix: `effect-sync/` → `legation/`; CVR store prefix:
  `effect-sync/cvr/` → `legation/cvr/`. Existing IndexedDB/KV state under the
  old prefix is orphaned — clients rehydrate via a full pull; export any
  pending journal before upgrading offline clients.
- Metrics: `effect_sync_*` → `legation_*`; spans: `effect-sync.*` →
  `legation.*`
- Default BroadcastChannel name: `effect-sync` → `legation`; Redis hint
  stream: `effect-sync:hints` → `legation:hints`; cache metadata header:
  `x-effect-sync-cache-meta` → `x-legation-cache-meta`
