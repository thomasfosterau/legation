---
"@thomasfosterau/legation-browser": minor
---

`BrowserConnectivity.withBrowserConnectivity` now reports connectivity from a
service worker. A worker has no `window`, so it gets no `online`/`offline`
events; there the wrapper probes `navigator.onLine` on a timer and emits a
status change when it flips. When the navigator goes back online, `statusChanges`
emits `connected` once, even if the transport still reports `disconnected`, so
the sync loop's push and pull run at once for a worker-hosted engine instead of
waiting on the push retry backoff (#328). `status` still reads the worse of the
two signals. Where a `window` exists the `online`/`offline` listeners are
unchanged, but the reconnect edge applies there too: an `online` event emits
`connected` once whatever the transport reports. `statusChanges` is therefore
an edge trigger for the sync loop, not a mirror of `status`; a connection label
should read `status`.

The new optional `pollInterval` option sets the probe interval (default
`"5 seconds"`); it bounds how long a reconnect takes to reach the sync loop.

Auto-push still does not consult connectivity status: a push attempted while
the status is `disconnected` goes out anyway, because `navigator.onLine` can be
wrong and a failed push already backs off. This is documented on the module.
