---
"@thomasfosterau/legation-effect": patch
---

`MemoryBackend` no longer double-applies a mutation when two `applyMutations`
calls for one client group overlap (a client retry while the first push is
still in flight). The commit re-checks the client's `lastMutationId`, so a copy
whose mutation another call already committed is dropped, reported as a replay
skip, and no longer moves the watermark backwards. The bump also takes the max,
so `lastMutationId` never falls. `Backend` guarantee 1 now states that calls for
one client group may overlap and what must hold when they do.
