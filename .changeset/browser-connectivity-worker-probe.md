---
"@thomasfosterau/legation-browser": minor
---

`BrowserConnectivity.withBrowserConnectivity` now reports connectivity from a
service worker. A worker has no `window`, so it gets no `online`/`offline`
events; there the wrapper probes `navigator.onLine` on a timer and emits a
status change when it flips, so the reconnect edge (push, then pull) reaches a
worker-hosted engine without waiting on the push retry backoff (#328). Where a
`window` exists the event listeners are unchanged.

The new optional `pollInterval` option sets the probe interval (default
`"5 seconds"`); it bounds how long a reconnect takes to reach the sync loop.

Auto-push still does not consult connectivity status: a push attempted while
the status is `disconnected` goes out anyway, because `navigator.onLine` can be
wrong and a failed push already backs off. This is documented on the module.
