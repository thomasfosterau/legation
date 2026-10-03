---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
"@thomasfosterau/legation-devtools": patch
---

Add a one-sentence doc comment to every exported declaration that had none, so editor hovers on the published `.d.ts` say what each export is for. This covers the root `@thomasfosterau/legation-effect` surface (`Backend`, `Server`, `ClientStore`, the `Predicate` and `Aggregate` constructors, …), its `/internal` seams, and the options and config interfaces of the other packages. The `@thomasfosterau/legation-effect` module header now counts seven concepts (Hydration joined ADR-0022's six). Documentation only; no API or behaviour changes.
