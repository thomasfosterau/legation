---
"@thomasfosterau/legation-effect": minor
---

Paginated-edge sync windows (ADR-0024, ADR-0022 program step 5): an included paginated edge's `first` now registers one windowed subset per parent row — `(foreignField = parent, edge order, limit)` — so the replica syncs the window instead of the whole dependent collection. `Collection.Relationship` gains the `"paginated"` kind with its declared order (derived from `Edge.paginated` by `Node.registry`), relational reads select edges as `{ name, first? }` (bare names still accepted), and the mirror protocol's related registrations carry the window (`SubscribeRelated.edges` replaces `names`). Windows follow parents entering and leaving the root window; displaced rows leave the replica through ordinary CVR union diffs.
