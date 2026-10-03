---
"@thomasfosterau/legation-effect": minor
---

The Client facade (ADR-0022, program step 4): the one-per-thread object
that runs many Query reads and mutations, with where a read is answered
being configuration the UI never sees. `Client.make` owns the engine
(store + transport from context; the sync loop starts automatically —
the forgotten-runSync bug class ends here); `Client.connect` joins an
engine hosted elsewhere (service worker, Electron main, a daemon) over a
`MirrorChannel`. Observing subscribes: live reads register their windows
for the stream's lifetime through a per-window ledger (one voice per
window, however many observers), `subscribe` pins a read beyond
observers, and includes resolve through the view's auto-subscribing
relational read with the plan's edge windows applied. `Client.fromView`
builds the facade over any `ClientView`. Additive; the
server-fallthrough tier is a later step.
