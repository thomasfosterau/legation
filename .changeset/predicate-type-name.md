---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-jsonapi": patch
---

Adds `Predicate.typeName`, the name `typeof` gives a value, read through `effect/Predicate`'s refinements. The engine's comparator tie-break, `Coverage`'s literal keys, the SQL compiler's literal check and `@thomasfosterau/legation-jsonapi`'s flat filter codec use it (or `effect/Predicate` directly) in place of a runtime `typeof`; behaviour is unchanged.
