---
"@thomasfosterau/legation": minor
---

`Subset.TypedPredicate`'s (on `@thomasfosterau/legation/internal`) `isNull` and `isNotNull` take `field: keyof A & string` instead of an unused type parameter `K`. Calls are unchanged; only a call that passed the type argument explicitly (`isNull<"x">("x")`) needs it dropped.
