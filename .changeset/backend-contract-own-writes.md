---
"@thomasfosterau/legation-effect": minor
---

`BackendContract.verifyBackendContract` checks that `getRows` reflects a backend's own writes to rows a listing has cached (rule 12, #444). The rule lists a collection so it caches a row, applies an update through the backend, then checks that `getRows` returns the post-write value without a re-list. It then applies a delete and checks that `getRows` omits the row. A backend that caches listed rows and does not bring its cache into line with its own writes now fails `verifyBackendContract`, where it passed before. `MemoryBackend`, `SqlBackend` (SQLite and PostgreSQL) and the atomic `JsonApiBackend` pass the rule unchanged. The rule uses the existing `putRow` and `delRow` contract mutators and the contract's evaluation collection, so a backend registers nothing new. A third-party backend that caches rows must update or evict its cache when it applies its own writes.
