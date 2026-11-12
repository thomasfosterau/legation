---
"@thomasfosterau/legation": minor
---

**Breaking:** `DuplicateNameError`'s `name` field is renamed `duplicate`. The old field shadowed `Error.name`, so `error.name` returned the duplicated name instead of `"DuplicateNameError"`; it now returns the error's own name.
