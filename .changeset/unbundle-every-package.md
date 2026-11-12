---
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-devtools": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-svelte": patch
---

`dist/` is one ESM module per source module instead of merged shared chunks (#678), so a consumer's bundler can tree-shake with `sideEffects: false`. The entries and their exports are unchanged.
