---
"@thomasfosterau/effect-sync-jsonapi": minor
---

Extend the JSON:API sync derivation with server-side query narrowing and
relationship resolution.

- `JsonApiQuery`: a pluggable `QueryEncoder` seam that translates a `Subset`
  into a JSON:API query string, with `JsonApiSync` accepting a `queryEncoder`
  override. The shipped default soundly encodes the `eq`/`in` conjuncts and
  `sort` it can express (`filter[field]=…`, `sort=field,-field`) and drops the
  rest; since `Subset.apply` re-runs the full predicate locally, the server
  filter only needs to return a superset. A dedicated JSON:API package can
  supply a richer encoder (operator filters, cursor pages).
- `Relationships`: resolve JSON:API relationship linkage against the local
  mirror — `resolve`/`hydrate` (pure) plus `query`/`observe` over a
  `ClientEngine`, giving a reactive `related()` (to-one and to-many) that
  re-resolves when a referenced row changes.
- Engine rows for JSON:API resources are now **flattened** (attributes at the
  top level, `id` and `relationships` reserved) so predicates and `orderBy`
  address attribute fields directly — matching how JSON:API `filter[field]`
  works. Mutator arguments remain structured (`{ id, attributes, … }`).
