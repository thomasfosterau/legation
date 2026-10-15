---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-sql": patch
---

Share the rejection-memory forgetting bound. `floorsOf` (a push's lowest mutation
id per client) and `forgetBelow` (drop a client's remembered rejections below its
floor) now live in a new `RejectionMemory` module, exported on
`@thomasfosterau/legation-effect/internal` for adapter authors. `MemoryBackend` and
`JsonApiBackend` bound their rejection memory with `forgetBelow`; `SqlBackend` shares
only `floorsOf` and keeps its own forgetting loop. No behaviour changes.
