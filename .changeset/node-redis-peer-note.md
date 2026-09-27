---
"@legation/node": patch
---

README: document that `redis` must be installed alongside. `@effect/platform-node`
peers `redis` (`>=5.0.0 <7.0.0`, non-optional) and its root entry imports it at
module load, so a setup that skips peers fails at import with
`ERR_MODULE_NOT_FOUND` even though this package never uses Redis.
