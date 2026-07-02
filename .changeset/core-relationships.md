---
"@legation/effect": minor
"@legation/jsonapi": minor
---

Add relationship declarations to collections and a protocol-agnostic `Related`
read over the mirror. A collection can now declare `one`/`many` relationships by
field mapping (`localField`/`foreignField`); `Collection.registry` rejects a
duplicate relationship name within a collection and a relationship pointing at an
unknown collection at build time. The new core `Related` module resolves and
incrementally maintains those joins over any `ClientEngine` mirror —
`query`/`observe` (a write to a related row re-hydrates without re-resolving the
base) and `related` (auto-subscribes the narrowed `foreignField IN (...)` foreign
subsets and tears them down with the scope). The incremental-join plumbing is
exposed as a strategy seam (`queryWith`/`observeWith`/`relatedWith` plus
`fieldMappingStrategy`), and the JSON:API `Relationships` module now delegates to
it with a linkage-based strategy — no behaviour change for existing users.
`Related.resolveExistsLocally` renders `Predicate.exists` on the client by
rewriting each node to an `In` over the synced foreign collection.
