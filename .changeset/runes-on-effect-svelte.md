---
"@legation/svelte": patch
---

The rune hooks and the engine runtime context are now built on `@thomasfosterau/effect-svelte` (^0.3.1): `useLiveStream` replaces the hand-rolled `$effect`/fiber plumbing behind every `use*` hook, and `createRuntimeContext` provides the typed context behind `setClientRuntime`/`getClientRuntime`. Hook APIs are unchanged. One semantics refinement: an `initial` seed now starts as a **non-waiting** `Success` (no spinner over server-rendered content) until the first live emission replaces it; re-subscription stale-while-revalidate behavior is unchanged.
