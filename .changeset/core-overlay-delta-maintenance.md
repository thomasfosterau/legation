---
"@thomasfosterau/legation-effect": minor
---

Delta-maintain the optimistic overlay instead of rebuilding it on every
mutate. `mutate` now runs the mutator's local handler through a tracked
writer that patches the cached overlay in place and publishes exactly the
`put`/`del` ops it performed, so observers fold the delta the same way
`LiveView` already folds confirmed-row patches — no journal replay, and no
full re-materialization, per mutation. A pull with pending mutations no
longer forces a global `Rebuild`: rebase now scopes to the union of the
patch's collections and whatever the pending-before-this-pull mutations
touch, falling back to a full rebuild only on a reset (`Clear`) or an
unrecognized mutator. This is the write-path follow-through anticipated by
the read-path selective re-evaluation work: per-mutation cost is now
proportional to the rows a mutation touches, not collection size × journal
length.
