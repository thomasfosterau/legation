---
"@legation/jsonapi": minor
"@legation/effect": patch
---

The filter-grammar bridge (ADR-0028 §5, #161): `@legation/jsonapi` now
translates both ways between effect-jsonapi's filter AST and the engine's
`Predicate`, parses a JSON:API URL into a `Query.Read`, and encodes the whole
predicate exactly. Bumps `@thomasfosterau/effect-jsonapi` to ^0.13.0, which
carries the grammar (`Filter`, `Sort`, `Query.Filter`, `Query.canonical`,
`Resource.filterable` / `Resource.sortable`).

- `JsonApiQuery.fromFilterAst(ast)` is total — every grammar node has an
  engine node — and `toFilterAst(predicate)` is partial: `Exists`, an empty
  `In` / `NotIn` list and a `null` literal have no URL form and return `None`,
  so callers fail closed. `foldConstants` folds the two definite cases away
  exactly (an empty `In` is false, an empty `NotIn` true under ADR-0028).
- `JsonApiQuery.parseRead(nodes, url)` / `parseParams(nodes, collection,
params)` decode `include`, `fields`, `sort`, `page` and `filter` with
  effect-jsonapi's `Query.schema` derived from the **node graph** (each node's
  filterable set — operators and literal kinds — and edges become the codec's
  declaration; `resourcesOf(nodes)` exposes the synthesised resources) and map
  them onto the read: `filter` → `where`, `sort` → `order`, `page[limit]` /
  `page[after]` → `first` / `after`, `include` → edge selects. Include paths
  are single level (ADR-0028 D1). `fields[]` is carried beside the read as a
  projection, never into the plan. Every rejection is a `QueryError` whose new
  `parameter` field names the offending query key (the 400's
  `source.parameter`). A `/{type}/{id}` URL reads as `filter[id]`, first 1.
- `JsonApiQuery.canonical(nodes, read)` compiles the read and encodes its plan
  through effect-jsonapi's canonical encoder — one string per plan, the
  subscription identity of ADR-0029 — and `parseRead` accepts it back.
- The encoder is exact: `defaultEncoder` pushes the whole predicate as the
  grammar's canonical `filter[...]` form (operators, `or`, `not`, `isnull`,
  `nin` included — nothing is dropped any more); `safeFilters` is gone. A
  subset whose predicate folds to false is answered without a request, and one
  with no URL form fails closed. `QueryEncoder.encode` now returns
  `Effect<Option<string>, QueryError>`; `JsonApiRequestOptions.filter` is a
  filter AST (`Filter.eq("status", "open")`) instead of a `Record<string,
string>`; query strings are serialised through `Query.serialise` (readable
  `[`/`]` in keys). `buildQueryString` lives in `JsonApiQuery` and stays
  re-exported from `CollectionLoader`.
- `NodeBridge.fromResource` / `registry` read the filterable set off the
  resource's own declaration (`Resource.filterable` / `Resource.sortable`): an
  attribute keeps its name and derives its kind from its schema; a to-one
  relationship's declaration lands on the edge's key field (`author` →
  `authorId`, kind `text`). The `filterable` / `sortable` options remain as
  per-field overrides (the way to give an `instant` its kind).
