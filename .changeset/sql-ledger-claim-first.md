---
"@thomasfosterau/legation-sql": minor
---

Action required: an executor without transactions must set `transactional: false`. The new optional `SqlExecutor.transactional` flag defaults to `true`, and with it `SqlBackend` now claims each mutation in the client's ledger row before its handler runs. An executor without transactions that leaves the default gets that claim-first order, where a crash can leave an id claimed and unapplied and the retry skips it. Set `transactional: false` to keep the handler-then-bump order.

`SqlBackend` claims each mutation with a conditional update from `id - 1` to `id`, instead of reading the ledger, running the handler and then bumping it unconditionally. Overlapping calls for one mutation now apply it once, and the watermark can no longer move backwards under READ COMMITTED (PostgreSQL's default). A permanent rejection still keeps the claim, and a transient failure gives it back. On the handler-then-bump order the bump takes the larger id, so a late call cannot move the watermark back. `Sql.Dialect` gains `greatest` for that bump. See the module docs for each dialect.
