---
"@thomasfosterau/legation-effect": minor
---

Fix a gap in `ClientEngine.mutationStates` (#116): a mutation compacted out of
the journal by a paced strategy (`Paced.ts`'s debounce/throttle/coalesce, via
`dropIfPending`) never transitioned off `"pending"` — the entry stayed stuck
showing an in-flight mutation forever, even though the journal no longer had
it. `MutationPhase` gains a `"dropped"` phase (and a matching
`MutationDropped` `EngineEvent`/`MutationEvent`), and `dropIfPending` now folds
every compacted id to it, so a mutation-timeline consumer (a devtools journal
panel, #120) never shows a phantom pending entry for a compacted mutation.
