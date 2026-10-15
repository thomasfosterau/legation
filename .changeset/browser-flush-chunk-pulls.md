---
"@thomasfosterau/legation-browser": patch
---

Background Sync's flush can now pull between chunks when the journal is larger than half the unpulled bound (see the `@thomasfosterau/legation-effect` changeset). A flush whose pull between chunks fails now rejects its `sync` event with a transport error instead of reporting `Flushed`, so the browser reschedules it and the journal waits for the next flush.
