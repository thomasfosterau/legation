---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
"@thomasfosterau/legation-devtools": patch
---

Peer `effect ^4.0.0` (was `>=4.0.0-rc.118`), and `@effect/platform-node` /
`@effect/platform-browser` `^4.0.0` likewise, per the peer-range policy: the
range is raised only when a dependency requires it. The range form changes
(the caret no longer admits the 4.0 release candidates or Effect 5); every
package's tests pass at `effect` 4.0.0.

`@thomasfosterau/legation-svelte` peers `effect ^4.0.2`: its dependency
`@thomasfosterau/effect-svelte` 0.6.0 peers `effect >=4.0.2`.
