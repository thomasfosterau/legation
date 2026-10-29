---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

Web Push as a poke carrier, to converge a client with no open tab (#214). `PushPoke.sink` (on `@thomasfosterau/legation-effect/internal`) is an `InvalidationSink` that sends a contentless marker, `PushPoke.payload`, to the push subscriptions the app's registry names for a change, through the app's own sender: the library holds no credential and stores no subscription. The coalescing window and the per-target budget are required options with no default. In `@thomasfosterau/legation-browser`, `PushPoke.listen` is the worker's `push` listener: the library's push registers the Background Sync tag by default, or pulls with `action: "pull"`, only when the replica is stamped for whoever is signed in now, and every other push is left to the app's own handler. `ServiceWorkerHost.start` takes it as `pushPoke`.
