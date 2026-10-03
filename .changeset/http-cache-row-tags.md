---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

Per-row HTTP-cache tags (#207): row-granular cache invalidation, closing the
collection-level ceiling noted in `.changeset/http-cache-invalidation.md`.

- **Change feed carries row ids** (`@thomasfosterau/legation-effect`): the `PullCompleted`
  `EngineEvent` now also carries `rows` — the `(collection, id)` pairs the
  pulled patch's `Put`/`Del` ops touched (a `Clear` contributes to
  `collections` only, since it has no finite row list). Always present,
  possibly empty.

- **Fine tag convention** (`@thomasfosterau/legation-browser`): `HttpCacheInvalidation` gains
  `defaultFineTagFor` — `collection:{name}:{id}`, one level finer than the
  existing `collection:{name}` (`defaultTagFor`). `collectionChanges` now
  yields `Touched` (`{ collections, rows }`) and `invalidateOnChanges` evicts
  the union of both tag sets on every change. The coarse eviction is kept
  deliberately even though every touched row's collection is already implied:
  an aggregate document can be staled by a row it does not yet contain, which
  has no fine tag to match.

- **Response tagging + budget** (`@thomasfosterau/legation-browser`): `tagsFor(collection,
rowIds)` builds a response's tags — coarse plus one fine tag per row, up to
  `FINE_TAG_ROW_BUDGET` (43, derived in a comment against the real ceiling on
  the `x-legation-cache-meta` header these tags ride on). Beyond the budget, a
  response is tagged coarse-only with `budgetExceeded: true` on the result.
  `tagsForObserved` pairs the same computation with a logged warning and the
  new `legation_cache_tag_budget_exceeded_total` counter
  (`Telemetry.cacheTagBudgetExceededTotal`), so the fallback is observable
  rather than silent.

Both granularities share one tag spelling across the client-side
invalidation path and response tagging, so the edge/KV invalidation sink
(#206) can reuse it unchanged.
