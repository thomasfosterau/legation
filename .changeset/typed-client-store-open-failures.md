---
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-svelte": patch
---

A client store that fails to open is now a typed `StoreError` you can recover from, where it was a layer defect.

**`legation-browser`.** `IndexedDbClientStore.layer` is now `Layer<ClientStore, StoreError, IndexedDb>`, and `layerWindow` and `layerNamespaced` are `Layer<ClientStore, StoreError>`: a database the browser refuses to open (storage unavailable, or quota refused) fails the layer with the `StoreError`. `ElectedHostOptions.dependencies` now takes `Layer<ClientStore | ClientTransport, StoreError>`, and `ElectedHost.run` is `Effect<ElectedHost, StoreError, Scope>`: it fails with the dependencies' error only where there is no `navigator.locks` and the tab hosts at once (an elected tab still logs the failure and keeps mirroring). Migration: where you annotate one of these layers as `Layer<ClientStore>`, add `StoreError` to its error channel, or handle it on the layer: `Layer.catch(() => ClientStore.layerMemory)` to fall back to an in-memory replica, or `Layer.orDie` to keep the old behaviour. Handle (or `Effect.orDie`) the new error channel of `ElectedHost.run`.

**`legation-jsonapi`.** `JsonApiSyncOptions.store` now takes `Layer<ClientStore, StoreError>`, and `JsonApiSync.layer` is `Layer<ClientEngine, StoreError, HttpClient>`, failing with the error of a `store` that cannot open. Migration: handle the new error channel where you build the layer (`Layer.catch`, or `Layer.orDie` for the old behaviour).

**`legation-svelte`.** `kit`'s `clientRuntime` accepts a fallible store (`store: Layer<ClientStore, StoreError>`), so `IndexedDbClientStore.layerWindow()` still passes as it is. A store failure the app leaves uncaught is a boot defect, as before; catch it on the layer to recover.
