---
"@thomasfosterau/legation-jsonapi": minor
---

`NodeBridge` stores a to-one relationship's edge under the relationship's declared storage key, `Relationship.one(ref, { key })` / `Relationship.optional(ref, { key })` (effect-jsonapi 0.20), before falling back to the `` `${name}Id` `` convention. The `via` option still wins over both. A resource that already declares `key` and relied on the convention now bridges to the declared field.
