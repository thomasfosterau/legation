---
"@legation/browser": minor
---

Flush the journal after the tab has closed (#213, #246). `BrowserConnectivity`
flushes on reconnect and return-to-visible, but only while a page is open;
`BackgroundSync` covers the rest by answering a Background Sync `sync` event
in the service worker.

- **`BackgroundSync.listen`** installs the worker's `sync` listener. Call it at
  the top level of the worker script: a worker woken for `sync` dispatches the
  event straight after evaluating the script, so the listener holds the event
  open (up to `readyTimeout`) until a host attaches, then flushes. Its
  `identity` option is **required** (see below).
- **`ServiceWorkerHost.start({ backgroundSync })`** attaches the host's engine
  to the listener for as long as it serves, and registers the tag only when
  the journal cannot drain now: a mutation journaled while the worker is
  offline (`navigator.onLine === false`, or the `offline` option), or a push
  that failed terminally (`syncFailures`). Never on an online write — online,
  Chromium fires a fresh registration's `sync` at once, which would push each
  write on its own and bypass `pushDebounce` and paced compaction.
  `registerOnJournal: false` turns host-side registration off.
- **`BackgroundSync.register`** is the page-side registration helper. It never
  fails: `"Registered"`, `"Unsupported"` (no `SyncManager` — Safari, Firefox)
  or `"Refused"`, logged at debug level only. Absent Background Sync, the
  journal flushes on the next connectivity signal.
- **`BackgroundSync.flush`** is the flush itself: `ClientEngine.push`, not a
  replay loop, so exactly-once comes from the backend's ledger and a refused
  write is surfaced as `rejected` rather than discarded. A transport failure
  rejects the event so the browser reschedules it. `"Flushed"` means the push
  completed (possibly with nothing pending).

Only the library's own tag (`BackgroundSync.defaultTag`, or `tag`) is
answered. The identity boundary (#212) applies: quarantined entries are
unreachable from push, and `identity` — the fingerprint of whoever is signed
in now, as the app resolves it in the worker — is required, so a flush skips
(`"IdentityChanged"`) whenever the store is not stamped for that identity,
which catches a tab closed before `Client.reset` ran. An app with no sign-in
passes `BackgroundSync.identityUnchecked` to opt out explicitly.

`ServiceWorkerHost`'s docs no longer say Background Sync registration stays
app code. Periodic Background Sync is still app code, deliberately.
