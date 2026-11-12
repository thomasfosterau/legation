---
"@thomasfosterau/legation": patch
---

`Predicate.evaluate` now dispatches through a per-tag evaluator table instead of a `switch` (#497). Its behaviour is unchanged.
