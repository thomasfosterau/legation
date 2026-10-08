---
"@thomasfosterau/legation-sql": patch
---

`SqlBackend` claims each mutation in the client's ledger row before its handler runs: a conditional update from `id - 1` to `id`, instead of reading the ledger, running the handler and then bumping it unconditionally. Overlapping calls for one mutation now apply it once, and the watermark can no longer move backwards under READ COMMITTED (PostgreSQL's default). A permanent rejection still keeps the claim, and a transient failure gives it back on D1 too. On D1, a crash after a claim can now leave the mutation skipped, since D1 has no transactions (#342); see the module docs for each dialect.
