---
"@legation/svelte": patch
---

Require `@thomasfosterau/effect-svelte` >= 0.3.2, which ships a `svelte` export condition. Consumers no longer need the manual dual-svelte workarounds — vite-plugin-svelte now auto-detects effect-svelte as a Svelte library and shares the app's single copy of svelte. The commerce example drops its `optimizeDeps.exclude` / `ssr.noExternal` for effect-svelte accordingly (verified in a real dev-server browser run: no `lifecycle_outside_component`). Vitest still needs its `server.deps.inline` — that's a vitest node-module externalization concern, independent of the export condition.
