---
"@thomasfosterau/legation-devtools": minor
---

Devtools attaches over the mirror seam (#136): `Devtools.fromMirror(mirror, options)` builds the same `DevtoolsCore` from a tab that reaches a service-worker-hosted engine only through a `Mirror`.

- The reads ride core's introspection request kinds (served by a host given its store). The row counts and the four actions ride this package's own kinds, `Devtools.requests` (named `@thomasfosterau/legation-devtools/…`), served once the host is given `Devtools.hostRequests(engine, store)`.
- **Breaking:** `DevtoolsCore.syncFailures` is now a point-in-time read (`Effect` of the engine's recent terminal sync failures, oldest first), not a `Stream`; the Svelte panel re-reads it on every event and every 5 seconds. The core's reads and actions may also fail with `HostRequestError`, and `events` may fail with it before it is retried. The Svelte store helpers (`toStreamStore`, `toSnapshotStore`, `toLogStore`) accept streams that can fail, and stop on a failure.
