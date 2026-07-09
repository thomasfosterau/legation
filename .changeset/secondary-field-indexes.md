---
"@legation/effect": minor
---

Add secondary field-value indexes over the local store (#113): `eq`/`In`
predicates resolve via an in-memory hash index and range `Compare`s via an
ordered index, instead of a full collection scan, in `ClientEngine.query`,
live-query rebuilds (`observe`, seq-gap collapse), and `Related`'s foreign-index
priming (which now also narrows its query to the pinned `foreignField IN (...)`
values instead of reading the whole foreign collection).

Declare indexed fields on a `Node`/`Collection` (`indexes: ["done", "authorId"]`,
mirroring `hintKeys`), or pass `autoIndex: true` to `Client.make`/
`ClientEngine.make` to auto-discover indexable fields from registered subsets'
predicates. Both are opt-in — zero-config behavior is unchanged, and any
predicate the index can't narrow (`Or`, `Not`, `ne`, non-indexed fields) falls
back to today's full scan. Indexes are in-memory only, maintained from
confirmed-row patch deltas and rebuilt lazily from the store; they are used
only while a collection's journal is empty (a pending optimistic mutation
falls back to a full scan for correctness).

A benchmark (`secondary-index.bench.ts`) shows a ~25-30x speedup for a
selective point predicate (1/100th match rate) over a 50k-row collection.
Memory overhead is roughly 300-400 bytes per indexed row per declared field
(measured via heap snapshots), i.e. ~15-20MB for a 50k-row collection with one
declared index.
