---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-jsonapi": patch
---

**Breaking:** `Edge.one`, `Edge.many` and `Edge.paginated` now discriminate on `_tag` instead of `kind`, and so do the `Incremental` / `Derive` join options (`JoinOptions._tag: "inner" | "left"`). Edges and join options work with `P.isTagged`, `Match.tag` and the other `_tag`-based helpers. The tag values are unchanged, and no wire or storage format carries an edge's discriminant, so nothing persisted needs a migration. `Collection.Relationship.kind` and `Query.EdgePlan.kind` are unchanged.

`@thomasfosterau/legation-jsonapi`: the edges `NodeBridge.fromResource` derives carry `_tag`, as above.

Migration:

- Read an edge's variant with `edge._tag` (or `P.isTagged(edge, "one")`, `Match.tag("one", …)`) where you read `edge.kind`.
- Pass `_tag: "inner"` / `_tag: "left"` to `Derive.join`, `Incremental.makeJoin` and `Incremental.joinFromScratch` where you passed `kind`.
- An edge written as a literal object (`{ kind: "one", target, via }`) becomes `{ _tag: "one", target, via }`; one built with `Edge.one` / `many` / `paginated` needs no change.
