---
"@legation/effect": patch
---

A refused or failed journal append no longer burns a mutation id (#258).
`journalHighWater` refusals, quota errors and aborted transactions used to leave
the id counter one ahead of the journal, so the next mutation carried
`lastId + 2`, every backend rejected the gap, and the journal never drained.
`ClientStore` gains `appendNext(draft)`, which allocates the id and appends as
one store step (the key-value store checks the high-water mark first and
persists the counter last, healing it from the journal's highest id after a
crash); the engine journals through it. Custom `ClientStore` implementations
must provide `appendNext`; `nextMutationId` stays for low-level use but an id
reserved without an append is a gap.
