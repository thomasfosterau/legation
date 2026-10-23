---
"@thomasfosterau/legation-effect": minor
---

Add `CrudMutation`: the graph-derived CRUD mutations (ADR-0030 §5). For every
node, `{type}/create`, `{type}/update` and `{type}/delete` with args in the
graph row form (`{ type, id, attributes }`, `one` edges as their `via` keys)
and the client handler that writes them; `update` is a no-op when the row is
absent, so a patch behind a rejected create leaves no phantom row.
`CrudMutation.entries(nodes, { writes })` spreads into `Mutation.registry`.
