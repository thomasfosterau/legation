---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": patch
---

Make the acknowledged-but-unpulled tail durable in `ClientStore` (#336). A push acknowledgement parks the applied mutations in the store, out of the pending journal, so they are never pushed again. Their effects stay overlaid until a pull reports them, and now also across a restart, a hydration snapshot and the BackgroundSync push-only flush. A restart between a push acknowledgement and the next pull no longer shows the confirmed rows without the mutation.

- **Pull release.** A pull records its watermark in the store before it writes its rows, and releases the covered journal and tail entries after. A crash in that window is finished on the next open, so the effect is counted once.
- **Identity reset.** The tail is cleared with the rows it was overlaid on, in the store's open-time reset and in the engine's runtime reset.
- **Hydration.** `Hydration.SnapshotSchema` gains an optional `unpulled` field. `dehydrate` writes it when the tail is not empty; `hydrate` parks it. A snapshot without the field loads with an empty tail.
- **IndexedDB.** The tail uses the existing key-value layout, so there is no new object store or index and the database version does not change.

Action required: a custom `ClientStore` must implement five new members: `unpulled`, `parkUnpulled`, `beginRelease`, `releaseUnpulled` and `clearUnpulled`. `ClientStore.makeMemory`, `ClientStore.makeKeyValue` and `IndexedDbClientStore` already do. `beginRelease` may be a no-op for a store that cannot survive a restart, since it only matters where an open can finish an interrupted release.
