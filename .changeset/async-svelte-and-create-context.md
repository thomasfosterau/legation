---
"@thomasfosterau/legation-svelte": minor
---

Async Svelte support and a type-safe runtime context. Every live rune hook's
result gains an awaitable `promise` alongside `current`: pending until the
first data arrives (suspending a `<svelte:boundary>`'s `pending` snippet),
then an already-resolved promise replaced per emission and on input change —
awaiting expressions re-run with fresh rows while Svelte keeps the previous
UI on screen; stream failures reject into the boundary's `failed` snippet.
The runtime context is built on Svelte's `createContext`, which raises the
package's Svelte peer requirement to `>=5.40`.
