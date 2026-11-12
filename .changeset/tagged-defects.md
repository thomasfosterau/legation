---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-jsonapi": patch
---

The defects thrown for invalid arguments or definitions (`ClientEngine.make`'s `unpulledLimit`, `FractionalIndex.generateBetween`, the filter corpus and the JSON:API linkage checks) are now tagged errors with the same messages, not bare `Error`s.
