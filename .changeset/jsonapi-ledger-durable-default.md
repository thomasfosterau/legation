---
"@thomasfosterau/legation-jsonapi": minor
---

`JsonApiSync.layer` keeps the ledger durable when its client store is: a new `keyValueStore` option (the durable `KeyValueStore` behind the client store) makes the ledger default to `Ledger.keyValue` over it, so a reload keeps the acknowledged mutation ids and remembered rejections. An explicit `ledger` still overrides it, and without `keyValueStore` the ledger stays in memory as before (#468). The README and the backend's delivery notes now say that a failed ledger write after a successful server write fails the push, and the resend re-applies those writes, the same window as a crash.
