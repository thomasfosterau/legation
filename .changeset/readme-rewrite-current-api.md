---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-browser": patch
---

Rewrite the `@thomasfosterau/legation-effect`, `@thomasfosterau/legation-node` and `@thomasfosterau/legation-browser` READMEs against the current API. The stubs are replaced by install, usage and API sections with examples that compile against the published entry points: the root `Node`, `Query`, `Mutation`, `Client` and `Server` surface, `HttpSyncServer` on Node, and the browser host, store, cache and Background Sync modules. The `@thomasfosterau/legation-effect` package description now names the ADR-0022 surface instead of the v1 vocabulary. Documentation only; no API or behaviour changes.
