---
"@legation/effect": minor
"@legation/browser": minor
"@legation/jsonapi": minor
---

Sync-loop scheduling (#33). `ClientEngine` grows a configurable scheduler on
`runSync`, driven by `Effect.Schedule` and the existing `statusChanges` seam:

- `syncLoop.pushDebounce` auto-pushes after `mutate`/`mutateEncoded`, debounced
  so a burst of mutations coalesces into a single push.
- `syncLoop.pullInterval` pulls periodically as the correctness backstop, so a
  client converges over pull alone even without pokes.
- The baseline triggers (pull on poke, push+pull on reconnect) are retained,
  and every scheduling fibre is scoped — interrupted when the engine scope
  closes.

`@legation/browser` adds `BrowserConnectivity.withBrowserConnectivity`, which
layers `navigator.onLine` + `online`/`offline` + `visibilitychange` onto any
`ClientTransport` so `statusChanges` becomes truthful for carriers (like the RPC
transport) that otherwise report themselves permanently connected, and a
return-to-visible surfaces a poke.

`@legation/jsonapi` `JsonApiSync` now configures the core loop (`pullInterval`,
`pushDebounce` options, 5-second default interval) instead of running its own
`Effect.forever` poll; `JsonApiSync.start` just runs `runSync`.
