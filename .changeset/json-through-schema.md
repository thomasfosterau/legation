---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
---

JSON is encoded and decoded through Schema's JSON codec. The text is byte-identical; a value with no JSON text (`undefined`, a function, a `BigInt`, a cycle) now fails with a `SchemaError` instead of a `TypeError` or an `undefined` result.
