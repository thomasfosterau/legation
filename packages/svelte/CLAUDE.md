# packages/svelte — `@thomasfosterau/legation-svelte`

Svelte 5 bindings. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Deliberately thin: everything the engine can do alone is `@thomasfosterau/legation-effect`; this package adds reactive re-subscription and SSR hydration. Imports from the workspace: `@thomasfosterau/legation-effect` only. Peers: `effect`, `svelte`, optional `@sveltejs/kit`.
- **Two entries**: `src/index.svelte.ts` (`.`) holds the rune hooks and must stay a `*.svelte.js` module in `dist/` (it calls `$state` / `$effect`, which only the consumer's Svelte compiler handles; `exports` has a `svelte` condition for it). `src/kit/index.ts` (`./kit`) is the SvelteKit surface and is plain TypeScript.

## Invariants

- Hooks are called during component initialisation: they read the Client from context (`setClient`, or `setClientRuntime` for an app-built runtime) and register a `$effect`. With no Client set (`setClient(undefined)`, as on the server), a hook renders from its seed and fails with `ClientUnavailable` only when it needs the Client.
- Inputs are thunks read inside `$effect`, so a read re-subscribes when the state it touches changes, keeping the previous value visible as a waiting result.

## Tests

`src/__tests__/` mount real components (Vitest project `svelte`, jsdom, the Svelte plugin with `experimental.async`); `src/kit/__tests__/` are plain node tests.
