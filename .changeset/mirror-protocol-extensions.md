---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-svelte": minor
---

Named queries and auto-subscribing relational reads cross the mirror
protocol (ADR-0021 follow-up). `ClientView` gains
`subscribeQuery`/`unsubscribeQuery`/`queryNamed`/`observeNamed` and
`related` — both hosts satisfy the widened seam (`ClientViewError` now
includes `QueryError`). The tab↔host protocol adds
`SubscribeNamed`/`UnsubscribeNamed` (the host engine owns the server
round-trip) and `SubscribeRelated`/`UnsubscribeRelated`, where the host runs
the reconcile loop AND the join and the tab receives resolved rows
(`RelatedUpdate`) — data work stays off the main thread. `EngineHost` takes
an optional `registry` for relational resolution and refcounts all
registration kinds per tab. A new `HostReady` announcement makes
registrations survive host restarts: a starting host broadcasts it and
every mirror replays the registrations it holds — covering killed service
workers and tabs that raced the worker's boot. On a mirror, observing IS
subscribing: `TabMirror.observe`/`observeNamed`/`related` auto-register
their subject with the host for the stream's lifetime through a per-key
interest ledger (a mirror only carries keys some tab registered, and the
host refcounts per tab, so the ledger posts `Subscribe` on first interest
and `Unsubscribe` only when the last observer ends and no explicit
`subscribe` pins the key). In `@thomasfosterau/legation-svelte`, `namedQuery`,
`useNamedQuery`, and `useRelated({ subscribe: true })` now work over
mirror-only runtimes (the internal engine-lookup fallback is removed).
