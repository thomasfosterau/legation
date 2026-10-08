---
"@thomasfosterau/legation-effect": patch
---

A push acknowledgement no longer reverts the view before the pull lands (#286). The push used to trim a mutation's optimistic effects from the overlay as soon as the backend acknowledged it, so an observer saw the pre-mutation value until the next pull. The applied entries now stay overlaid until a pull reports them, and the pull reveals the confirmed row in one change. A permanently rejected mutation still leaves the view at its push, since the backend applied nothing.

The acknowledged entries are held in memory and bounded at 1024: past that, the oldest are released with a warning. An identity reset clears them. A pull's confirmed rows and its `lastMutationIds` are read as one snapshot, re-reading (up to three passes) when a push commits mid-pull, so, on a backend whose mutations commit their `lastMutationId` with their effects, a pull never leaves out a push its rows carry and an acknowledged mutation is never counted twice. `MemoryBackend` and `SqlBackend` on D1 do not commit them together yet, so a mutation can still be counted twice there until the next pull (#341, #342). Only when a push lands on every pass does a pull report a push its rows lack, which reverts that mutation until the next pull.
