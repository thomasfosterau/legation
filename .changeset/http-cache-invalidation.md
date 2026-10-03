---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

Drive HTTP-cache invalidation from collection changes (#49).

- **`PullCompleted` enrichment** (`@thomasfosterau/legation-effect`): the `PullCompleted`
  `EngineEvent` now carries `collections` — the distinct collections the pulled
  patch touched (a `Clear` stands for every collection the client currently
  holds, since it resets the whole view). The field is always present. This lets
  a collection-scoped reaction fire even on a client with an empty journal (the
  common case, where a pull emits a `Patch` change and no `ViewRebuilt`).

- **`HttpCacheInvalidation`** (`@thomasfosterau/legation-browser`): `invalidateOnChanges` forks
  a scoped fibre that evicts every cached response tagged for a changed
  collection via the store's `invalidateTags`; a store error is logged and
  swallowed, never fatal. `collectionChanges` derives the change feed from an
  engine's `engineEvents` (mapping `PullCompleted.collections` and scoped
  `ViewRebuilt.collections`, dropping empties). Wire it in a service worker by
  forking `invalidateOnChanges` alongside `ServiceWorkerHost.run` (recipe in the
  host's doc comment).

The tag convention is `collection:{name}` (the default `tagFor`): a response
tagged `collection:todos` is evicted whenever `todos` changes. This is a
collection-level granularity ceiling — every response tagged for a changed
collection is evicted; a per-row `collection:{name}:{id}` convention could
follow once patch-op row ids are plumbed through to the change feed (not
implemented here).
