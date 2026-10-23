---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": minor
---

Batch a pull's subsets (#505). `Backend` gains an optional `evaluateMany(context, subsets)`,
one entry list per subset, each equal to what `evaluate` gives for it. The sync server's pull
evaluates its subsets through the new `Backend.evaluateAll`, which calls `evaluateMany` when the
backend has it and `evaluate` per subset otherwise, so `MemoryBackend`, `JsonApiBackend` and any
backend of your own work unchanged. `BackendContract` gains rule 14: a backend's `evaluateMany`
must equal its per-subset `evaluate` over the contract's subsets, the generated corpus included.

`SqlBackend` implements `evaluateMany` as one `UNION ALL` statement per pull, plus one per `exists`
node. `Sql.Dialect` gains the optional `unionRows` member (`Sql.UnionRows`) saying how each arm
carries its row: `Sql.sqlite` carries the relation's own columns by position (looked up once per read
relation), so values reach the backend exactly as `evaluate` reads them; `Sql.postgres` carries the
row as JSON (`row_to_json`), and a pull whose rows hold an integer past 2^53 falls back to
`evaluate` per subset. A hand-written dialect without `unionRows` keeps one statement per subset.
See the README for the PostgreSQL column types JSON does not carry as the driver reads them.
