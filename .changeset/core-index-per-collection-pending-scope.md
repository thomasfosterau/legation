---
"@legation/effect": patch
---

`CollectionIndex` acceleration (#113) is no longer bypassed for every
collection whenever any mutation is pending (#133 item 4): since #109 the
engine already computes exactly which collections a batch of pending
mutations touches for the rebase path, and `indexForCollection` now reuses
that to scope the bypass — a pending mutation on collection A leaves
collection B's declared/auto-discovered index usable. An unscoped result
(an unknown mutator, undecodable args) still conservatively falls back to a
full scan for every collection, same as before. No public API changes —
`indexes`/`autoIndex` options and query results are unaffected; this only
changes when the full-scan fallback kicks in.
