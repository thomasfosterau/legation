---
"@thomasfosterau/legation-effect": patch
---

Backend guarantee 1 now states that mutations from different client groups are serialisable (#353): a handler's reads see a state equivalent to some serial order of the committed mutations, so no committed write is lost to another group's concurrent commit of a row it read.

`MemoryBackend` meets this. Every row a handler reads from committed state is recorded with its version, and the commit re-checks those versions inside the same state update that applies the writes. If another group changed a row since the read, nothing is written and the handler runs again on the new state. Overlapping calls for one client group behave as before (#346, #355). A handler can therefore run more than once, so its effects outside its writer must be safe to repeat.

**Action required for custom `Backend` implementations:** `applyMutations` must meet guarantee 1, by a store-wide lock, a commit that re-checks each row the handler read and runs the handler again when one changed, or serialisable isolation on a database. A backend that does not meet it does not conform. The `BackendHandler` contract also now allows a handler to run more than once, so handler effects outside the writer must be safe to repeat.
