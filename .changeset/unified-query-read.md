---
"@thomasfosterau/legation-effect": minor
---

The unified Query read (ADR-0022, program step 3): `Query.make({
collection, where, include, order, first, after })` declares a read shaped
like the data — an equality-map `where` (full `Predicate` as the escape
hatch), edges by name in `include` (with per-edge `first` windows), order
tokens, cursor pagination — and `Query.plan` compiles it against the node
graph to a root `Subset` plus edge plans (`Subset`/`Predicate` become the
plan's internal representation). `Query.run`/`Query.observe` execute reads
over any `ClientView.Reader`, resolving includes through the existing
`Related` machinery and applying paginated-edge order + `first` windows to
the resolved join (true per-edge sync windows land with the
paginated-edge step). Named queries are the same concept with a name —
`Query.named` (the old `(name, args)` form of `Query.make` still works via
overload).
