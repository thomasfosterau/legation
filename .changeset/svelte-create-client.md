---
"@thomasfosterau/legation-svelte": minor
---

Boot the bindings without an Effect runtime (#147). `createClient(options)` takes `Client.make`'s options and returns a `ClientHandle` with its own `dispose`; `setClient(handle)` puts it in context and `getClient()` reads it back. `setClient(undefined)`, as on the server, renders every hook from its `initial` seed, and a hook that needs the Client fails with `ClientUnavailable`, so no stand-in runtime is needed during SSR. A runtime the app builds itself still works: `fromRuntime(runtime)`, or `setClientRuntime(runtime)`. The error for a hook used with nothing in context now names `setClient(createClient(…))`.
