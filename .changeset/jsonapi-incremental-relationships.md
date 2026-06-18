---
"@thomasfosterau/effect-sync-jsonapi": minor
---

Make relationship live queries incremental. `Relationships.observe` (and the
auto-subscribing `related`) now maintain the join instead of re-resolving it on
every change: the base page is kept current by `engine.observe(subset)` and each
referenced collection by its own `engine.observe`, so a write to a related row
re-hydrates the join without re-querying the base, and a base change that shifts
_which_ collections are referenced re-establishes the referenced observers (via
`switchMap`). Per-collection lookup indexes are cached and only the changed
slice is rebuilt; changes that don't move the resolved result are deduped away.

This also fixes a correctness gap exposed by the now-deduped
`ClientEngine.observe`: a change to _only_ a referenced collection (e.g. editing
a comment without touching its issue) no longer fails to update the join.
