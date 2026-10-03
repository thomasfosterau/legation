---
"@thomasfosterau/legation-effect": patch
---

Fix a lost-write window in paced compaction (#249 follow-up). Once
`ClientStore.compactPending` had made a compaction durable (the write-ahead
intent), a failure applying it (an IndexedDB quota error, an aborted
transaction) or an interrupt before the engine caught up left the store
renumbered while the engine, `Paced` trackers and `mutateWithAck` handles kept
the old ids, so the next paced call dropped the user's newest write. Now
`compactPending` returns the committed renumbering as soon as the intent is
durable (the next journal operation, or the next open, rolls the rest
forward), the store commit and the engine's re-key run uninterruptibly, the
memory store updates journal and counter together, and `Paced` journals and
remembers an id in one uninterruptible step.

Also: a journal found at engine boot or hydrated from a snapshot is frozen
(never renumbered), since it may already have been pushed; a durable
compaction reads only the journal index and the bodies it moves instead of the
whole journal; `dropped` is now a valid phase on the mirror wire (a dropped
state used to make the whole `MutationStatesUpdate` undecodable); and the
compaction events are emitted inside the journal lock.
