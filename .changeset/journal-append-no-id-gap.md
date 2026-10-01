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

An id that has left the journal is never issued again: `acknowledge` and
`quarantinePending` raise the client's counter to the highest id they remove (in
the key-value store, before deleting anything), and the key-value `appendNext`
is uninterruptible. Previously a lost counter write (or an interrupt between the
index and counter writes) let the next append reissue an acknowledged id, which
the backend skipped as an idempotent duplicate, silently losing the write. The
in-memory store's journal writers are now mutually exclusive: `appendMutation`,
`appendNext`, `acknowledge`, `compactPending`, `nextMutationId`,
`quarantinePending`, `releaseQuarantine` and `discardQuarantine` all hold one
permit, so a read-then-write operation can no longer overwrite a concurrent
append or a released quarantine. `appendNext` heals its counter from the journal
exactly as the key-value store does, and so does `nextMutationId` on both
stores.
