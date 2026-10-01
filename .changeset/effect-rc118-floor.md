---
"@legation/effect": minor
"@legation/browser": minor
"@legation/node": minor
"@legation/jsonapi": minor
"@legation/sql": minor
"@legation/cloudflare": minor
"@legation/svelte": minor
"@legation/devtools": minor
---

Target Effect `4.0.0-rc.118`: every package peers `effect >=4.0.0-rc.118`
(#261), and the `@effect/platform-browser` / `@effect/platform-node` peers use
the same floor. Install `effect` and every `@effect/*` companion at
`4.0.0-rc.118` or later together.

The packages import Effect's modules at their rc.118 paths (`effect/rpc`,
`effect/http`, `effect/http-api`, …); rc.118 removed the `effect/unstable/*`
export paths, so the packages don't resolve beside an earlier `effect`.

**`@legation/jsonapi`** depends on `@thomasfosterau/effect-jsonapi@^0.16.1`,
the first release that peers `effect >=4.0.0-rc.118`.

**`@legation/svelte`** depends on `@thomasfosterau/effect-svelte@^0.4.0`, for
the same reason.
