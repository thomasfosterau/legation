# @legation/devtools

A devtools panel over the introspection substrate (#120): the journal &
mutation timeline, subscriptions & collections, sync activity log, and
actions (force pull/push, a simulated-offline toggle, drop a subscription,
and a destructive clear-store behind a confirm).

Architecture: a framework-agnostic headless core (`@legation/devtools`) that
owns all data acquisition — built entirely over already-public substrate
(`@legation/effect/internal`'s `Introspection`, `ClientEngine.mutationStates`,
`ClientEngine.engineEvents`/`syncFailures`, `ClientStore`) — plus thin,
idiomatic panels per framework: `@legation/devtools/react` and
`@legation/devtools/svelte`. Each panel just runs the core's Effects/Streams
through its own framework's reactivity; neither has a data-acquisition path
of its own.

This is a **functional first cut**: plain, legible, correct. Visual polish is
out of scope — a human design pass comes later.

## Scope

The owned-engine case only: an app that constructs its own `ClientEngine` +
`ClientStore` in-process (see `examples/svelte-northwind`).
Attaching over the mirror seam (a service-worker-hosted engine) needs a
mirror-protocol introspection extension that doesn't exist yet — tracked as a
follow-up substrate issue (#136).

## Usage

```ts
import * as Devtools from "@legation/devtools";

// `engine`/`store` are the same values you provided to `ClientEngine.make`.
const devtools = Devtools.make(engine, store, {
  // Optional: wires the "simulated offline" action. Build `offline` with
  // `Transport.simulateOffline` and wrap your real transport with it.
  offline: { setOffline, isOffline },
});
```

React:

```tsx
import { DevtoolsPanel } from "@legation/devtools/react";

<DevtoolsPanel core={devtools} />;
```

Svelte:

```svelte
<script lang="ts">
  import { DevtoolsPanel } from "@legation/devtools/svelte";
</script>

<DevtoolsPanel core={devtools} />
```

The `/react` and `/svelte` entry points are separate exports so an app that
never imports them pays nothing for the panel in its production bundle.

Note: `@legation/devtools/svelte` ships raw `.svelte`/`.ts` source (not a
pre-compiled bundle) — any Svelte 5 app already has a bundler that compiles
`.svelte` files, so this composes directly with your app's own build.
