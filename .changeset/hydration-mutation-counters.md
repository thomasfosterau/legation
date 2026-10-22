---
"@thomasfosterau/legation-effect": minor
---

Carry each client's mutation id counter in a hydration snapshot (#271). Once
acknowledgements had drained the journal, a `Hydration.Snapshot` held no record
of the ids the backend had already applied, so a store hydrated from it and used
under the same `clientId` issued those ids again; the backend skipped them as
duplicates and the client acknowledged them, losing the writes silently.

`Hydration.dehydrate` now writes an optional `counters` field (each client's
highest issued id, left out when there are none), and `Hydration.hydrate` raises
the store's counters to it, never lowering one, so a reused `clientId` continues
above its acknowledged ids. A snapshot without `counters` still loads as before.

`ClientStore` (on `./internal`) grows two required members, `mutationCounters`
and `raiseMutationCounters`, and `ReplicaState` a `counters` field; the memory
and key-value stores implement them. A custom `ClientStore` must add both.
