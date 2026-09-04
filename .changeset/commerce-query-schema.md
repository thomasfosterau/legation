---
"@legation/jsonapi": patch
---

Add `JsonApiQuery.querySchema(nodes, collection)` and
`JsonApiQuery.singleRowSchema(nodes, collection)`: the query codecs of a
collection's `list` and `get` endpoints, as the node graph declares them —
the codecs `parseParams` and `singleRowParams` decode with — for
`Endpoint.list(R, { query })` / `Endpoint.get(R, { query })`, so an
effect-jsonapi endpoint served by `RestHandlers` declares the grammar the
handler parses (the key-field spelling of a relationship filter,
`filter[categoryId]`, and `sort=id`).
