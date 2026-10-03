---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-jsonapi": minor
---

Predicate-aware fan-out matching. A committed write now pokes a client group
only when some hinted change plausibly affects one of its subscriptions,
rather than every group whose subscriptions touch the hinted collection.

Change hints gain an optional, wire-compatible `values` field carrying the
current row values of the PUTs in a change (`MemoryBackend`, `SqlBackend` and
`JsonApiBackend` populate it best-effort; a backend that can't cheaply produce
a value omits it). An old, value-less hint decodes and behaves exactly as
before. The `SyncServer` fan-out loop matches a value-carrying PUT against the
subscription's predicate, a delete against the group's last-synced CVR, and
falls back to the collection-level match for value-less hints and `Exists`
predicates (soundness first — over-matching is safe, under-matching would
delay convergence). A new `legation_pokes_suppressed_total` metric counts the
pokes predicate matching avoids.
