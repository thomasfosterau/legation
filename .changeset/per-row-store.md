---
"@thomasfosterau/legation-effect": minor
---

Per-row and per-mutation durable storage for the KeyValueStore-backed `ClientStore`. Confirmed rows now persist one key each at `row/{collection}/{id}` behind a small `rowIndex/{collection}` id-array, and pending mutations one key each at `journal/{clientId}/{mutationId}` behind a compact ordered `journalIndex`. A `putRow`/`appendMutation` rewrites a single value plus a tiny index instead of the whole collection or journal, and `acknowledge` drops acked mutation bodies without rewriting the survivors.

`ClientStore` gains a batched `applyRowOps`, through which the engine's pull path now routes: a patch is grouped by collection so each collection's id-index is rewritten at most once per patch and each row value written once — patch-apply value I/O scales with patch size, not collection size (a checked-in `bun run bench` counts the KVS writes to demonstrate it).

A store opened at the previous whole-blob layout is migrated forward transparently on first open (rows, journal, counters, cookie split losslessly), stamped with a `__layout` version key; a corrupt legacy blob falls back to clearing rows and the cookie so the client re-pulls. A new `journalHighWater` option (KVS-only) makes `appendMutation` fail with a clear `StoreError` rather than ever silently dropping a mutation intent; the failure surfaces through `mutate`.
