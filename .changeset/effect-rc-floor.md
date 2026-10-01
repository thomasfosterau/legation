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

Peer the Effect v4 release-candidate line through an open floor rather than
an exact pin (#222), so an app can install `@legation/*` beside
`@thomasfosterau/effect-auth` and `@thomasfosterau/effect-jsonapi` and resolve
a single copy of `effect`. The published floor is `>=4.0.0-rc.118` (see
`effect-rc118-floor.md`), on `effect` and on the `@effect/platform-browser` /
`@effect/platform-node` peers.

**`@legation/jsonapi`**: a repeated shorthand filter key
(`?filter[name]=a&filter[name]=b`) is read as the comma list it spells
(`filter[name]=a,b`, an `In` predicate) rather than rejected with a 400,
because `@thomasfosterau/effect-jsonapi` accepts the repeated-key spelling at
every list-valued position.

**`@legation/node`** declares `engines.node: ">=22"`, the Node line CI runs.
The other packages run in browsers and workers too and deliberately declare no
`engines` (ADR-0003).
