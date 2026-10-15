---
"@thomasfosterau/legation-jsonapi": minor
---

`JsonApiBackend` takes an optional `ledger` store, so its ledger (the acknowledged mutation ids and the remembered rejections of each client group) survives a restart (#468). `Ledger.keyValue` keeps it in an Effect `KeyValueStore`, and `JsonApiSync.layer` accepts the same option. Without one, the ledger stays in memory as before, and a restart of the backend forgets it: a resent mutation that was already applied looks new, and a permanent rejection can no longer be reported to a replayed copy or a pull. The README documents the restart caveat.
