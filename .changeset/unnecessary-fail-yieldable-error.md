---
"@thomasfosterau/legation": patch
---

Internal: a failure built from a yieldable error is yielded directly instead of wrapped in `Effect.fail` (#562). Behaviour is unchanged.
