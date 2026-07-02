---
"@legation/effect": minor
---

Add `LiveView`: a modular, incrementally-maintained materialized view — a
subset's result (filtered, sorted, windowed) kept current by row deltas instead
of re-scanning the collection. `put`/`del` place or remove a single row at its
sorted position and the visible page is sliced from the maintained order, so a
change outside the page never re-sorts it and pagination boundaries are handled
(an insert pushes a row out of the page; a delete pulls the next one in).

`ClientEngine.observe` now maintains a `LiveView` per query: on the read path
(empty journal) it applies the pull's per-row patch deltas incrementally and
drops re-emits when the page didn't move; it falls back to a full rebuild only
when the optimistic overlay shifts. `Subset` gains reusable `comparator`,
`sortFiltered`, and `window` helpers (with `apply` composed from them).
