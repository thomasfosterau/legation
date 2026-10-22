---
"@thomasfosterau/legation-jsonapi": patch
---

Depend on `@thomasfosterau/effect-jsonapi` `^0.17.0`. A document whose read carries `include` now has an `included` member even when nothing resolved (`included: []`), as JSON:API 1.1 requires of a compound document; a read without `include` still omits it. An effect-jsonapi 0.17 endpoint answers 400 to a `filter[…]` its query schema doesn't declare, so an endpoint served by `RestHandlers` must declare the handler's grammar with `Endpoint.list(R, { query: JsonApiQuery.querySchema(nodes, collection) })`, as documented.
