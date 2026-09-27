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

Move onto the Effect v4 release-candidate line and publish an open peer floor
instead of an exact pin (#222).

**Peer ranges.** Every package now peers `effect: ">=4.0.0-rc.113"` (and the
same range on the `@effect/platform-browser` / `@effect/platform-node` peers)
instead of the exact `4.0.0-beta.107`. An app can now install `@legation/*`
beside `@thomasfosterau/effect-auth` and `@thomasfosterau/effect-jsonapi` and
resolve a single copy of `effect`. `rc.113` is the floor the sibling libraries
publish; the gates pass on it and on `4.0.0-rc.115`, the exact version this
repository pins for development.

**`@legation/jsonapi`** depends on `@thomasfosterau/effect-jsonapi@^0.15.1`
(was `^0.13.0`). One visible consequence: a repeated shorthand filter key
(`?filter[name]=a&filter[name]=b`) is now read as the comma list it spells
(`filter[name]=a,b`, an `In` predicate) instead of being rejected with a 400,
because effect-jsonapi accepts the repeated-key spelling at every list-valued
position.

**`@legation/node`** declares `engines.node: ">=22"`, the Node line CI runs.
The other packages run in browsers and workers too and deliberately declare no
`engines` (ADR-0003).

The bump is `minor` rather than `patch` because every consumer's `effect` must
move from the beta line to the rc line in the same change.
