---
"@thomasfosterau/legation": patch
---

Optional option-bag members are forwarded without conditional empty-object spreads (#562); behaviour is unchanged.

`@thomasfosterau/legation/internal` gains `Defined.fields`, which copies an object's defined members so a caller holding `undefined` omits the key.
