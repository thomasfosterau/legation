---
"@thomasfosterau/legation-jsonapi": minor
---

Derived REST `list` / `get` handlers over the engine's read path (#163): a
JSON:API `GET` is ADR-0025's `read` operation with a document body, so the
REST tier and the sync tier now share one grammar, one evaluator and one auth
path — the premise of ADR-0029's "same URL, same result".

- `RestHandlers.make({ nodes, backend, policy, context, middleware?, prefix? })`
  binds handler factories for effect-jsonapi's `Endpoint.list` / `Endpoint.get`:
  `rest.list(resource)` and `rest.get(resource, { notFound })`. Each parses the
  request URL into a `Query.Read` with `JsonApiQuery.parseParams`, resolves the
  request's identity through the `context` seam (HTTP request → `SyncContext`,
  the HTTP analogue of `IdentityResolver`), runs the read through the
  filterable check, the deny-by-default auth filters and `Backend.evaluate` +
  `getRows` with the two-phase include resolution, and serialises the rows.
  Scoping is the policy's alone: an anonymous request to a private collection is
  an empty collection for `list` and a 404 for `get`, as the sync tier's empty
  allow-set behaves. A URL the grammar rejects is the codec's 400 error
  document with `source.parameter`, before any backend call; a collection the
  policy does not declare is a 403; a missing row fails with the endpoint's own
  404 class. Linkage follows the resource's declaration: every
  `Relationship.many` the endpoint's resource declares is resolved — on the
  primary resource and on each included resource's own declaration — because
  effect-jsonapi resource schemas require every declared relationship, and
  nothing the resource does not declare is touched; `include` decides
  `included`. A paginated node edge lists and includes under a
  `Relationship.many` declaration (links plus its rows' linkage in the edge's
  order) and carries links only under `Relationship.paginated`. Derivation is
  opt-in per endpoint, beside hand-written handlers.
- `DocumentWriter.collection(input)` / `DocumentWriter.data(input)` is the one
  rows-to-document function both the REST handlers and the service-worker façade
  (#164) serialise through: a pure function of the node graph, the read, the
  resolved rows and the `fields[]` projection. Attributes are the node's, `one`
  edges link through their key fields, collection edges through the resolved
  edge rows, paginated edges carry the spec's `links` (and their rows' linkage
  when included); `included` is deduplicated
  with full linkage checked; `fields[type]` projects attributes after linkage;
  `links.self` is the read's canonical string and `links.next` the same query
  with `page[after]` at the last row when the window is full; `linkage` carries
  the edge rows resolved for included resources. Node rows only — `Derive.ts`'s
  `JsonApiRow` has no node graph to plan against.
- `RestHandlers.queryErrorDocument(error)` renders a `QueryError` as the 400
  document (the codec's own when the rejection was a decoding failure).
