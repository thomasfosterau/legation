---
"@thomasfosterau/legation-sql": patch
---

`SqlBackend` claims each mutation in the client's ledger row before its handler runs: a conditional update from `id - 1` to `id`, instead of reading the ledger, running the handler and then bumping it unconditionally. Overlapping calls for one mutation now apply it once, and the watermark can no longer move backwards under READ COMMITTED (PostgreSQL's default). A permanent rejection still keeps the claim, and a transient failure gives it back.

`SqlExecutor` gains an optional `transactional` flag (default `true`). An executor without transactions sets it to `false`, and `SqlBackend` then keeps the handler-then-bump order it had before this change, so a crash cannot leave an id claimed and unapplied. Third-party executors without transactions must set the flag, since the default is now the claim-first order. See the module docs for each dialect.
