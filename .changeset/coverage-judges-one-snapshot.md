---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-jsonapi": patch
---

A covered read is judged and answered from one snapshot of its root rows, so a
pull between the coverage judgment and the answer can no longer serve a root row
whose edge windows are not pulled yet (#426). `Client.query` and the façade read
the root once; `Client.coverageOf` and the coverage check it builds take an
optional `{ snapshot }` the verdict is judged over. A mirror that predates
`PulledRegistrations` still judges coverage from its registrations alone, so the
#422 race persists for it until it is upgraded.
