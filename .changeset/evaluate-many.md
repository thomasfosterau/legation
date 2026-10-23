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
node, each arm carrying its row as JSON. `Sql.Dialect` gains the optional `rowJson` and `columnsOf`
members that build it: `Sql.postgres` uses `row_to_json`, `Sql.sqlite` uses `json_object` over the
relation's columns, looked up once per read relation. A hand-written dialect without `rowJson`
keeps one statement per subset. See the README for the column types JSON carries faithfully.
