---
"@legation/browser": patch
---

Gate `BackgroundSync`'s registration on the journal being unable to drain
(#246, follow-up to #213). The host used to register the sync tag on every
journaled mutation, and online Chromium fires a fresh registration's `sync`
almost at once, so every online write got its own push: `pushDebounce` was
bypassed and paced compaction (#117) lost every race, because `dropIfPending`
never touches an entry a push has claimed. `registerOnJournal` now registers
only when a mutation is journaled while the worker is offline
(`navigator.onLine === false`, or the new `offline` option) or a push fails
terminally (`syncFailures`). It also subscribes to both before returning, so
a write journaled straight after the host starts is not missed.

`ListenOptions.identity` (and `FlushOptions.identity`) is now **required**.
The #212 guard is a hard dependency of a background flush: quarantine covers
only a reset that ran, and a tab closed before `Client.reset` leaves the old
identity's journal pushable. An app with no sign-in passes the new
`BackgroundSync.identityUnchecked` to opt out explicitly. This is breaking
for code written against the unreleased #213 surface; it has not shipped.

Also: `"Flushed"` is documented as "the push completed (possibly with nothing
pending)", and the `HostNotReady` debug line says when it was the browser's
last chance.
