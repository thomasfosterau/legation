---
"@thomasfosterau/legation-effect": minor
---

Add `Derive`: client-local **derived live queries** as bare, composable
combinators over observed sources — `filter` (arbitrary JS predicate),
`map`/`select`, `join` (arbitrary key equality, inner + left), `groupBy`
returning grouped rows, `distinct`, and `orderedWindow` (orderBy + limit). This
is the client-side expressiveness tier (#114): the arbitrary joins, DISTINCT,
row-level GROUP BY, and computed/cross-field predicates the serializable
`Subset`/`Predicate` wire language deliberately does not carry, done in memory
over already-synced rows.

Each combinator takes any source satisfying the `ClientView.observe` shape — an
owned engine, a mirror, or **another combinator**, so queries compose from
queries — and is maintained **incrementally** from keyed row deltas by pure
engines (`Incremental`), never refolded per change. Per ADR-0027 these are
#114's combinator engines, not a separate operator core: each mirrors a proven
seam's technique — `orderedWindow` the `LiveView`/`OrderedTree` order, `join`
`Related.makeJoinEngine`'s keyed buckets + reverse index, `groupBy`
`Aggregate`'s running-fold-plus-`byId`. Each carries a delta-in/delta-out
property test against a naive from-scratch recompute.

Results are an Effect `Stream` and, via `Derive.atom`, an Atom on the standard
reactivity surface, so framework bindings need nothing new. Leaf subscriptions
compose through the refcounted `Subscriptions` manager (`Derive.observed`) and
release on scope close, tearing the whole chain down together.

**The boundary rule (ADR-0027): derived combinators never widen what syncs.**
They see only the rows a client already holds; the serializable Query/Subset
tier alone decides what the server ships. Both `Incremental` and `Derive` live
behind `@thomasfosterau/legation-effect/internal` (read-layer machinery, no new public noun).
ADR-0027 (client-local IVM delta model) records the two-tier read model and the
never-widens-sync rule these consume.
