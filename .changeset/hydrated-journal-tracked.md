---
"@thomasfosterau/legation-effect": patch
---

`ClientEngine` now tracks every journal entry it pushes in `mutationStates`, including entries a direct store write put there (`Hydration.hydrate` into a running engine) and entries whose boot-time journal read failed. Each one settles to `"acknowledged"` or `"rejected"` like a locally journaled mutation, so a server rejection of a hydrated entry now emits `MutationRejected`. Before, the entry was pushed but untracked, and a rejection for an untracked id was silently ignored (no event, no state change). An entry the engine already tracks keeps its phase, and a rejection that contradicts an outcome already observed is logged at warning level and ignored.
