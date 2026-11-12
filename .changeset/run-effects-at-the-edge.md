---
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
"@thomasfosterau/legation-devtools": patch
---

Effects that must run at a callback edge run on a runtime the adapter owns (#562). Background Sync's listener, the Svelte undo hooks and the devtools panel use a module-level `ManagedRuntime.make(Layer.empty)` in place of the implicit-runtime `Effect.runPromise` / `runFork` / `runSync`, and the room transport's poke socket offers to its queue with `Queue.offerUnsafe`. No behaviour changes.
