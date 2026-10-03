---
"@thomasfosterau/legation-devtools": patch
---

Fix the types of the `@thomasfosterau/legation-devtools/svelte` entry in the published
package. `svelte/store.ts` and `DevtoolsPanel.svelte` (shipped as source)
imported their `DevtoolsCore` types from `../src/Devtools.js`, which is not in
the tarball, so a consumer's type check couldn't resolve them. They now import
them from `@thomasfosterau/legation-devtools`, the package's own root entry.
