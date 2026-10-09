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
`KeyValueStore` already uses, so existing databases need no migration. The
database is opened without a version, so one a later version created still
opens; the browser store's `KeyValueStore` opens it the same way, in place of
the platform's, which pins version 1 and fails on a newer database.

If another connection upgrades that database, or deletes it, the store's
connections close, since they would otherwise block the change. From then on
every call fails with "the IndexedDB database was upgraded by another
connection; reload to continue", and the store does not reopen itself. A
database without the `entries` store fails its calls with a message that names
that store, and a sealed store's message now carries the reason from its cause.
