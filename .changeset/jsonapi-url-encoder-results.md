---
"@thomasfosterau/legation-jsonapi": minor
---

`JsonApiQuery` exports a `Result` twin beside each throwing URL encoder, as `Query.planResult` sits beside `Query.plan`: `canonicalResult`, `buildQueryStringResult`, `toRequestOptionsResult` and `flatFilterResult` return the `QueryError` their twin throws (an unknown collection or edge, a read or predicate with no URL form, a field compared with literals of several types) as a `Result` failure, for URLs built from runtime input. The throwing encoders are unchanged.
