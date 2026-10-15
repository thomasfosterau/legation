---
"@thomasfosterau/legation-jsonapi": patch
---

A per-resource push (no `atomic` endpoint) now refuses a mutation-id gap with a `BackendError` before it sends any write, as the atomic path already did. Before, a push could acknowledge a later mutation while an earlier one was never applied.
