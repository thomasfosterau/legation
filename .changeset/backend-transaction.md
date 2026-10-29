---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": patch
---

Add `Backend.transaction(steps)`. It builds a backend's `applyMutations` from its storage steps (`begin`, `open`, `run`, `commit`, `release`, `finish`, `atomically` — `Backend.withoutTransaction` for a store without one — and `maxAttempts`), and owns the mutation-id ledger rules: in-order application, idempotent skip, gap rejection, the bump travelling with each outcome (a permanent rejection commits no effects), and reporting a replay's committed rejection. `MemoryBackend` and `SqlBackend` now apply mutations through it, with no change in behaviour. A hand-assembled backend still type-checks, and `verifyBackendContract` still checks every backend (ADR-0009's #177 amendment).
