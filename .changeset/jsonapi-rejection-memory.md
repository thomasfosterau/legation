---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` remembers the permanent rejections its in-session ledger has made, so a replayed copy of a rejected mutation lists it in `rejected` with the same reason, as Backend guarantee 1 requires (#366). Before, the copy was skipped with no outcome, so a client whose push response was lost settled the rejected mutation as applied. A push forgets the rejections below its lowest id per client, as `MemoryBackend` does. The ledger is in-session, so the memory lasts as long as the backend instance.
