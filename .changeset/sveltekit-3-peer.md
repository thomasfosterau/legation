---
"@thomasfosterau/legation-svelte": patch
---

Support SvelteKit 3: the optional `@sveltejs/kit` peer widens from `^2.0.0` to
`^2.0.0 || ^3.0.0`. `@thomasfosterau/legation-svelte/kit` uses Kit only as the `Cookies` type
and always sets the client-group cookie's `path` explicitly (default `"/"`), so
it behaves the same on both majors; none of the APIs Kit 3 removes or moves
(`$app/paths` `base`/`assets`/`resolveRoute`, `$app/stores`, `$service-worker`,
`goto` options, the navigation and form type moves) are used. Tested against
Kit 3.0.1 (the package's dev pin, and the example apps) and Kit 2.69.1 (the
package suite run with its dev pin moved back to Kit 2).
