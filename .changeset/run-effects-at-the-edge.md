---
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
"@thomasfosterau/legation-devtools": patch
---

Effects that must run at a callback edge run with explicit services (#562). Background Sync's listener, the Svelte undo hooks and the devtools panel use `Effect.runPromiseWith` / `runForkWith` / `runSyncWith(Context.empty())` in place of the implicit-runtime `runPromise` / `runFork` / `runSync`, and the room transport's poke socket offers to its queue with `Queue.offerUnsafe`. No behaviour changes.
