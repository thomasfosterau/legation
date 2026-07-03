---
"@legation/effect": minor
"@legation/browser": minor
"@legation/svelte": minor
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
registration kinds per tab. In `@legation/svelte`, `namedQuery`,
`useNamedQuery`, and `useRelated({ subscribe: true })` now work over
mirror-only runtimes (the internal engine-lookup fallback is removed).
