---
"@legation/jsonapi": minor
---

`JsonApiSync.layer` accepts a `store` option to back the engine with a
durable `ClientStore` (IndexedDB, localStorage) instead of the in-memory
default, so the journal and confirmed rows survive reloads — the happy path
becomes offline-first with one option.
