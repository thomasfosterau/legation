---
"@thomasfosterau/legation-svelte": patch
---

The `effect` peer range is now `^4.0.0` (was `^4.0.2`), and the `@thomasfosterau/effect-svelte` dependency is `^0.6.1` (was `^0.6.0`). effect-svelte 0.6.1 peers `effect ^4.0.0`, so nothing forces a higher floor any more; CI's floor job already runs this package's tests on `effect` 4.0.0.
