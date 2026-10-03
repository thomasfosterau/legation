---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-svelte": patch
---

Engine-level reactive window retargeting (#133 item 3): `ClientEngine.
observeWindow(subset)` returns a `WindowObservation` (`rows` + `retarget`)
whose `retarget({ limit?, cursor? })` widens or advances the SAME open
observation's window in place — reusing `LiveView`'s maintained order
(`LiveView.retarget`, #112) instead of tearing the subscription down and
rebuilding it from scratch — and keeps the engine's tracked subscription in
step, so the next `pull` fetches the wider window from the server too.
`ClientView.observeWindow` exposes it over the `ClientView` seam for an
engine-backed view (present only there — a `Mirror` has no maintained
window of its own to retarget). `Subscriptions.acquireWindow` composes the
usual refcounted subscribe/release with it for callers that want lifecycle
management alongside retargeting.

`@thomasfosterau/legation-svelte`'s `useConnection` (`hooks.svelte.ts`) now retargets
through this seam for the common case (no `include`d edges, an engine-backed
view): `loadMore`/`reset` widen/shrink the same open observation instead of
letting `pages` force a resubscribe. A joined read, or a mirror-backed
connection, falls back to the original resubscribe-per-page behavior,
unchanged. No public API changes — `useConnection`'s signature and observed
behavior (growing window, `hasMore`, `reset`) are the same; only the
underlying re-registration is gone.
