---
"@thomasfosterau/legation-browser": minor
---

`ServiceWorkerHost.start` / `run` serve the introspection request kinds (#136) whenever the engine's `ClientStore` is in the context, so a tab reads the worker's engine with `Introspection.fromMirror(mirror)`, and take `requests`: further host-request handlers to serve, such as `Devtools.hostRequests(engine, store)`.
