---
"@legation/jsonapi": patch
---

Add `JsonApiQuery.querySchema(nodes, collection)`: the query codec of a
collection's `list` endpoint, as the node graph declares it — the codec
`parseParams` decodes with — for `Endpoint.list(R, { query })`, so an
effect-jsonapi endpoint served by `RestHandlers.list` declares the grammar the
handler parses (the key-field spelling of a relationship filter,
`filter[categoryId]`, and `sort=id`).
