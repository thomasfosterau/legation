---
"@legation/effect": minor
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
queries — and is maintained **incrementally** from row deltas by a new
version-free multiset operator core (`Incremental`), never refolded per change.
`orderedWindow` reuses `LiveView`/`OrderedTree`; `join` follows
`Related.makeJoinEngine`'s "re-derive only the affected rows" discipline;
`groupBy` follows `Aggregate`'s "touch only the affected bucket" discipline.
Each operator carries a delta-in/delta-out property test against a naive
from-scratch recompute.

Results are an Effect `Stream` and, via `Derive.atom`, an Atom on the standard
reactivity surface, so framework bindings need nothing new. Leaf subscriptions
compose through the refcounted `Subscriptions` manager (`Derive.observed`) and
release on scope close, tearing the whole chain down together.

**The boundary rule (ADR-0027): derived combinators never widen what syncs.**
They see only the rows a client already holds; the serializable Query/Subset
tier alone decides what the server ships. Both `Incremental` and `Derive` live
behind `@legation/effect/internal` (read-layer machinery, no new public noun).
ADR-0027 records the two-tier read model and the version-free multiset IVM
these consume.
