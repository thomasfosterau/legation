---
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-cloudflare": minor
"@thomasfosterau/legation-devtools": minor
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-node": minor
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-svelte": minor
---

Rename every package from the `@legation/*` scope to
`@thomasfosterau/legation-*` (#303): `@legation/effect` is now
`@thomasfosterau/legation`, and likewise for `browser`, `cloudflare`,
`devtools`, `jsonapi`, `node`, `sql` and `svelte`. Subpath entries keep their
paths (`@thomasfosterau/legation/internal`,
`@thomasfosterau/legation-svelte/kit`,
`@thomasfosterau/legation-devtools/svelte`). Update imports and dependency
names accordingly; no `@legation/*` name was ever published to npm.

`Context.Service` identifiers and `Symbol.for` keys follow the package name
(`@legation/effect/Client` → `@thomasfosterau/legation/Client`, and
per-package equivalents). The reserved identity sentinels
(`@legation/anonymous`, `@legation/unstamped`), the `legation/` client-store
prefixes, metric and span names are unchanged.
