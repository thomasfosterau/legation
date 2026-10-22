---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-cloudflare": patch
"@thomasfosterau/legation-devtools": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-svelte": patch
---

Build with `vp pack` (tsdown) instead of `tsc --build`. Each entry point is now one ESM bundle with one declaration file (the two `@thomasfosterau/legation-effect` entries share a chunk, so a value reached through `.` and `./internal` is still one instance). The `exports` map, entry file names and published dependency and peer ranges are unchanged, and nothing from npm is bundled. The source also moved to the Effect lint presets' idioms (namespace imports from `effect/*` submodules, `effect/Predicate` guards, tag-exact error recovery); behaviour is unchanged.
