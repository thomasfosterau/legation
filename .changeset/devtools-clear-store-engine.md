---
"@thomasfosterau/legation-devtools": patch
---

The `clearStore` action now clears through the running engine (`ClientEngine.clearRows`). It previously cleared the store directly, so the engine's view kept showing the cleared rows until something else invalidated it.
