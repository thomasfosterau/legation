---
"@thomasfosterau/legation-effect": minor
---

Sampling the journal-depth gauge no longer reads the whole journal (#260).
`ClientStore` gains `pendingCount`, the number of pending journal entries
without reading them: the memory store takes its journal's length, and the
key-value store (and so `@thomasfosterau/legation-browser`'s IndexedDB store) counts its
journal index, reading no mutation bodies. The engine samples
`legation_journal_depth` from it on every append, acknowledgement and paced
compaction, where it used to load every pending body to take
`pendingMutations.length`. A `mutate` also stops reading the journal when the
overlay cache is warm: the pending snapshot it took is needed only to rebuild
a cold cache. Custom `ClientStore` implementations must provide
`pendingCount`, and should count without loading the entries.
