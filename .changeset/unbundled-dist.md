---
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-devtools": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-svelte": patch
---

`dist/` is emitted one module per source module rather than as merged chunks, so a bundler drops every module an app doesn't reach (#678). The entries and their exports are unchanged.
