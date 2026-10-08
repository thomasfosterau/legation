---
"@thomasfosterau/legation-effect": patch
---

`MemoryBackend` now meets Backend guarantee 1. Each mutation's writes are staged
until its handler returns, and the staged writes commit with the client's
`lastMutationId` bump in one state update. A pull or `evaluate` that runs while
a handler is mid-flight no longer sees its writes ahead of the bump. A handler
that fails with `BackendError` after a write leaves no write behind, and a
`MutationRejected` still discards the writes while bumping the id. Handlers
still read their own staged writes, and row versions are assigned as before.
