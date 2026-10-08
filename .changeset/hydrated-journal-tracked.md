---
"@thomasfosterau/legation-effect": patch
---

`ClientEngine` now tracks every journal entry it pushes in `mutationStates`, including entries a direct store write put there (`Hydration.hydrate` into a running engine) and entries whose boot-time journal read failed. Each one settles to `"acknowledged"` or `"rejected"` like a locally journaled mutation, so a server rejection of a hydrated entry now emits `MutationRejected`. Before, the entry was pushed but untracked, and a rejection for an untracked id was silently ignored (no event, no state change).

A hydrated entry is announced like a local one: it emits `MutationJournaled` once, when it is adopted, so its outcome event follows an opening event as it does for a local mutation. The payload is the same `clientId` and `mutationId` the outcome events carry. Re-reading the journal does not announce an entry twice. This adds an event to the stream for hydrated entries, so `registerOnJournal` in `@thomasfosterau/legation-browser` (which listens for `MutationJournaled` while offline) now also registers a background sync for them; it is a consequence of this change, not a change to that package.

An entry the engine already tracks keeps its phase, and a rejection that contradicts an outcome already observed is logged at warning level and ignored. The journal read that adopts entries now runs under the engine's overlay lock, so a pull's trim cannot land between the read and the adoption.
