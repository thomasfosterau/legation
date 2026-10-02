---
"@legation/node": patch
---

Import `NodeHttpServer` from `@effect/platform-node/NodeHttpServer` instead of
the `@effect/platform-node` root, whose `NodeRedis` re-export imports `redis` at
module load. `@legation/node` now loads when `redis` isn't installed (e.g. with
`--legacy-peer-deps` or `auto-install-peers=false`); `redis` is still a declared
peer of `@effect/platform-node`, so install warnings remain. The README no
longer asks you to install `redis`.
