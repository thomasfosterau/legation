---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": patch
---

A durable pull now writes once, and an interrupted pull is never recorded. The
key-value seam gains an optional `AtomicKeyValue` service on
`@thomasfosterau/legation-effect/internal`: an all-or-nothing `apply` over
`set` and `remove` operations. When a host supplies it, `ClientStore` commits a
pull's rows, cookie, journal trim and unpulled-tail release as one batch, with
no release record, and a push acknowledgement's park and trim as one batch. A
store without the service keeps the release-record path from #387, unchanged,
and an open still finishes a leftover record either way.

`@thomasfosterau/legation-browser` supplies the service over IndexedDB: one
`readwrite` transaction on the database and object store the platform
`KeyValueStore` already uses, so existing databases need no migration.
