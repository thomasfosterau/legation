---
"@thomasfosterau/legation-jsonapi": minor
---

`JsonApiSync.layer` keeps the client store and the ledger durable together: a new `keyValueStore` option (the durable `KeyValueStore` the client store is built over) makes the client store default to `ClientStore.layerKeyValue()` over it, and the ledger default to `Ledger.keyValue` over it, so a reload keeps the journal, the acknowledged mutation ids and the remembered rejections (#468). An explicit `store` or `ledger` still overrides its default, and without `keyValueStore` both stay in memory as before. The README and the backend's delivery notes now say that a failed ledger write after a successful server write fails the push: mutations acknowledged earlier in that push stay acknowledged, and the resend re-applies the rest, the same window as a crash.
