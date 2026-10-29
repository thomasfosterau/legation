---
"@thomasfosterau/legation-effect": patch
---

`SyncServer.readSubsets`, the read behind `handleRead` and the derived REST handlers, evaluates its subsets through `Backend.evaluateAll` (one `evaluateMany` call on a backend that has it, such as `SqlBackend`'s single `UNION ALL`) and fetches their rows with one `getRows` per collection, instead of an `evaluate` and a `getRows` per subset (#534). Each subset's rows still come back in its evaluated order.
