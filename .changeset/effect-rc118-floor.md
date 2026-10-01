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

**Breaking: requires `effect@>=4.0.0-rc.118`.** Move onto Effect `4.0.0-rc.118`
and raise the published peer floor from `>=4.0.0-rc.113` to
`>=4.0.0-rc.118` (#261), on `effect` and on the `@effect/platform-browser` /
`@effect/platform-node` peers.

rc.118 removed every `effect/unstable/*` export path; the modules now live at
`effect/<module>` (`effect/unstable/rpc` is `effect/rpc`, `effect/unstable/http`
is `effect/http`, `effect/unstable/httpapi` is `effect/http-api`, and so on). The
source and the built `dist/*.d.ts` import the new paths, so the packages no longer
resolve beside an earlier `effect`. Upgrade `effect` and every `@effect/*`
companion in your app to `4.0.0-rc.118` together.

**`@legation/jsonapi`** depends on `@thomasfosterau/effect-jsonapi@^0.16.1`
(was `^0.15.1`), the first release that peers `effect >=4.0.0-rc.118`.

**`@legation/svelte`** depends on `@thomasfosterau/effect-svelte@^0.4.0` (was
`^0.3.2`), for the same reason.
