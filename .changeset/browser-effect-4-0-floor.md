---
"@thomasfosterau/legation-browser": patch
---

The IndexedDB store now type-checks against `effect` 4.0.x, the floor of its `^4.0.0` peer: it passed `keys` to `KeyValueStore.make` as an object literal, which only `effect` 4.1's options declare (#691). The store's behaviour is unchanged on both lines.
