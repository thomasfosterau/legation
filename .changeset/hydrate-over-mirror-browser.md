---
"@thomasfosterau/legation-browser": minor
---

The worker and elected hosts serve SSR hydration (#146).

- `ServiceWorkerHost.start` / `run` serve the `hydrate` request kind whenever the engine's `ClientStore` is in the context, and take `hydrationWindow`: a worker started over an empty replica holds its first pull until the first tab's snapshot arrives or the window ends.
- `ElectedHost.run` hands its host the store it builds from `dependencies`, so the elected tab serves the introspection and `hydrate` kinds too, and takes `requests` and `hydrationWindow`, forwarded as `ServiceWorkerHost` forwards them.
