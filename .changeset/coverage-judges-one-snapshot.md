---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-jsonapi": minor
---

A covered read is judged and answered from one snapshot of its root rows, so a
pull between the coverage judgment and the answer can no longer serve a root row
whose edge windows are not pulled yet (#426). `Client.query` and the façade read
the root once. `Client.coverageOf` takes an optional `{ snapshot }` (the root rows
already read, with their subset) that the verdict is judged over for that subset;
`Query.runRows` answers a read from rows already read. A mirror that predates
`PulledRegistrations` still judges coverage from its registrations alone, so the
#422 race persists for it until it is upgraded.
