---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-svelte": patch
---

Breaking: `Client.make` now returns `{ client, engine, store }` (`Client.Made`) instead of the Client alone (#142). The engine and store are the ones the Client runs over, so an app can attach devtools (`Devtools.make(engine, store, …)`) without building a `ClientEngine` by hand. Migrate with `const { client } = yield* Client.make(…)`. `Client.connect` is unchanged: a Client joined to a hosted engine owns neither. The package is 0.x, so this is a minor.
