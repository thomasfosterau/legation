---
"@legation/effect": minor
---

Add `Aggregate`: serialisable aggregate descriptors (`Count`, `Sum`, `Min`,
`Max`, `Avg`) over a subset's rows, as plain data plus an Effect `Schema` (so a
future server tier can carry them). `compute` / `computeGrouped` evaluate them
purely over already-filtered/sorted rows — `Sum` of an empty set is `0`, `Avg`
of an empty set is `undefined`, `Min`/`Max` are `undefined` when there are no
numeric values, and non-numeric field values are skipped.

The `ClientEngine` grows `queryAggregate` / `queryAggregateGrouped` (one-shot
over the current local view) and `observeAggregate` / `observeAggregateGrouped`
(live, re-emitting only when the value changes), with a matching `aggregate` /
`aggregateGrouped` atom surface in `EngineAtoms` and an `aggregate` /
`aggregateGrouped` store in `@legation/svelte`.

These are local-tier aggregates: they fold the rows a client has already
synced. A server-evaluated tier that folds the whole collection is explicit
future work.
