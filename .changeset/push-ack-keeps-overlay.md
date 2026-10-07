---
"@thomasfosterau/legation-effect": patch
---

A push acknowledgement no longer reverts the view before the pull lands (#286). The push used to trim a mutation's optimistic effects from the overlay as soon as the backend acknowledged it, so an observer saw the pre-mutation value until the next pull. The applied entries now stay overlaid until a pull reports them, and the pull reveals the confirmed row in one change. A permanently rejected mutation still leaves the view at its push, since the backend applied nothing.

The acknowledged entries are held in memory and bounded at 1024: past that, the oldest are released with a warning. An identity reset clears them. The server now reads a pull's `lastMutationIds` before it evaluates the patch, so a pull never reports a push whose effects it lacks.
