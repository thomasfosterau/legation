---
"@thomasfosterau/legation": minor
---

Each pull now reports every subscription's **total** (#210): how many rows its filter matches under the server's auth filter, whatever its order, limit and cursor. So a windowed subscription's total is the collection's count, not the window's.

- `PullResponse.totals` (wire, additive and optional) holds one number per `PullRequest.subscriptions` entry, in order. An older client ignores it, and an older server sends none. It is omitted when the backend cannot count, or when the pull middleware changed the number of subscriptions.
- `Backend.evaluateCounted` (optional) answers a pull's subsets with `evaluate`'s entries and each subset's total. `MemoryBackend` and `SqlBackend` provide it from the rows they already read: on SQL it is the same single `UNION ALL` statement as `evaluateMany`. `Backend.evaluateCountedAll` and `Backend.totalsOf` are the helpers. `BackendContract` gains rule 15, which checks the entries against `evaluate` and each total against the unwindowed subset.
- `ClientEngine.totalOf(subset)`, `ClientView.totalOf` (engine-backed views) and `Client.totalOf` read the last applied pull's total for a subscription with the same collection and filter. The totals are kept in memory only, and an identity reset clears them.
- `SyncServer.readTotal` counts a read's root subset through the read path's filterable check, middleware and auth filters. It is what the derived REST handler writes as `meta.total`.
- `Subset.applyCounted` and `Subset.unwindowed` are new helpers.

`ClientEngine` gains a required member, `totalOf`, so a hand-written `ClientEngine` must add it. A backend wrapper that overrides `evaluate` but spreads the inner backend now also inherits its `evaluateCounted`. Override it too (or set it to `undefined`) if the wrapper must see every pull's reads.
