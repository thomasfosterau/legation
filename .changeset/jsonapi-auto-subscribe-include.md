---
"@thomasfosterau/effect-sync-jsonapi": minor
---

Auto-subscribe and `include` for relationship resolution.

- `Relationships.related(engine, subset, names)` is an auto-subscribing
  relational read: it subscribes the base subset and, from its linkage, the
  narrowed `id IN (...)` subsets of each referenced collection, tracking the
  live linkage and tearing the subscriptions down with the scope. Callers no
  longer wire up the related collections by hand. Composes with the query
  encoder so the related subsets narrow server-side via `filter[id]`.
- `JsonApiSync`/`JsonApiBackend` gain an `includes` option (collection →
  relationship names). Listings then carry `?include=...`, and the compound
  document's related resources are harvested so an auto-subscribed
  `id IN (...)` subset is served from that response — the related rows arrive
  with their parent, no extra round trip.
