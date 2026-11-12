---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-jsonapi": patch
---

Internal: the remaining `switch` statements are exhaustive `Match`es (#497), so an input outside a case union now throws instead of silently yielding `undefined`, which no typed or decoded input reaches. The per-row evaluators (`Predicate.evaluate`, `Incremental`, `Aggregate`) keep their `switch` for speed. `Coverage.structuralKey` is now declared as a typed `const`, which shifts its emitted declaration; its type is unchanged.
