# packages/devtools — `@thomasfosterau/legation-devtools`

A devtools core over the engine's introspection substrate, with a Svelte panel. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- **The headless core (`src/`, entry `.`) owns all data acquisition**, built only over public substrate (`@thomasfosterau/legation-effect/internal`'s `Introspection`, `ClientEngine` streams, `ClientStore`). A panel just runs the core's Effects/Streams through its framework's reactivity.
- **`./svelte` ships raw source** (`svelte/index.ts`, `store.ts`, `DevtoolsPanel.svelte`), compiled by the consuming app: it is in `files`, not built by `vp pack`, and `vp run pack:check` checks the `svelte` condition's targets are packed. `svelte.config.js` exists only so svelte-check finds a Svelte config next to the panel.
- Imports from the workspace: `@thomasfosterau/legation-effect` only. `svelte` is an optional peer.

## Tests

`src/__tests__/` (Vitest project `node`). `examples/northwind` type-checks the panel with svelte-check (`vp run check:examples`).
