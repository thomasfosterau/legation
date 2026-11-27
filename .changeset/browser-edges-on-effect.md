---
"@thomasfosterau/legation-browser": patch
---

`BrowserConnectivity.withBrowserConnectivity` listens with `Stream.fromEventListener`. The `visibilitychange` listener is now on while the wrapped transport's `pokes` stream is read, rather than for the whole scope: a return-to-visible before anything reads `pokes` is no longer queued for later, and each reader of `pokes` gets its own poke. `PushPoke.listen` waits for a host on the same `SubscriptionRef` slot as `BackgroundSync.listen`, bounded by `Effect.timeoutOption`; its outcomes are unchanged.
