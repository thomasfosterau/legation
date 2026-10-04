---
"@thomasfosterau/legation-effect": patch
---

`ClientStore.makeKeyValue` now drops, when it opens, any journal index entry
whose body is missing. A crash (or a failed write) part-way through
`acknowledge` removed the acknowledged bodies but left their index entries,
which inflated `pendingCount` and the journal-depth gauge, could make the
`journalHighWater` check refuse appends early, and made `compactPending` refuse
to renumber over the gap until the next acknowledgement trimmed them. The
dropped ids stay reserved, so none is reissued, and `pendingCount` still reads
the index alone.
