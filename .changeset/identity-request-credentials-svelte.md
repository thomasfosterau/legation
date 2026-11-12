---
"@thomasfosterau/legation-svelte": minor
---

The SvelteKit surface (`./kit`) passes the request's credentials to the server's `IdentityResolver` (ADR-0035, #219): **`requestCredentials(event)`** (new) reads a `RequestEvent`'s headers into `Option.some(Authorization.RequestCredentials)`; `loadSnapshot`'s options take `credentials` (from `Hydration.SnapshotOptions`), and `runFormMutation` takes a fifth argument, **`RunFormMutationOptions`** (`{ credentials? }`). Without them the render or mutation is anonymous to a credential-reading resolver, as before.
