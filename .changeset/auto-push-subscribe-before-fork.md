---
"@thomasfosterau/legation-effect": patch
---

With `syncLoop.pushDebounce` set, `ClientEngine.runSync` now auto-pushes a
mutation journaled at any point after it starts. Previously the push-debounce
fibre subscribed to the push trigger only once it first ran, a few scheduler
turns after `runSync` returned. A mutation journaled in that gap, after the
connect leg had already read the journal, stayed pending until something else
pushed: another mutation, a reconnect or an explicit `push`. A mutation made
right after start-up could hit this whether `runSync` is forked (`Client.make`,
the browser package's `ElectedHost`) or awaited (`ServiceWorkerHost`, the
JSON:API package's `JsonApiSync`). `runSync` now subscribes before it forks any
of its fibres.
