# @thomasfosterau/legation-devtools

A devtools panel over the introspection substrate (#120): the journal &
mutation timeline, subscriptions & collections, sync activity log, and
actions (force pull/push, a simulated-offline toggle, drop a subscription,
and a destructive clear-store behind a confirm).

Architecture: a framework-agnostic headless core (`@thomasfosterau/legation-devtools`) that
owns all data acquisition — built entirely over already-public substrate
(`@thomasfosterau/legation/internal`'s `Introspection`, `ClientEngine.mutationStates`,
`ClientEngine.engineEvents`/`syncFailures`, `ClientStore`) — plus thin,
idiomatic panels per framework — today `@thomasfosterau/legation-devtools/svelte`. A panel
just runs the core's Effects/Streams through its own framework's reactivity;
it has no data-acquisition path of its own.

This is a **functional first cut**: plain, legible, correct. Visual polish is
out of scope — a human design pass comes later.

## Install

```sh
npm install @thomasfosterau/legation-devtools @thomasfosterau/legation effect
```

Add `svelte` (an optional peer, `>=5.40`) for the `@thomasfosterau/legation-devtools/svelte` panel.

## Effect version

Peers `effect ^4.0.0`. Tested against `4.1.2` (the version CI pins) and `4.0.0` (the floor; CI runs the tests against it on every PR); install one copy of `effect` in your app (ADR-0003).

## Scope

Two sources, one `DevtoolsCore`:

- **An owned engine:** an app that constructs its own `ClientEngine` + `ClientStore` in-process (see `examples/northwind`) builds the core with `Devtools.make(engine, store, options)`.
- **A hosted engine, over a mirror (#136):** a tab that reaches a service-worker-hosted engine only through a `Mirror` builds it with `Devtools.fromMirror(mirror, options)`. The reads ride core's introspection request kinds, which the host serves when given its store; the row counts and actions ride this package's own kinds (`Devtools.requests`, named `@thomasfosterau/legation-devtools/…`), which the host serves once given `Devtools.hostRequests(engine, store)`. A kind the host does not serve fails with a `HostRequestError` of reason `UnknownKind`, and a host that predates host requests leaves the reads `Unanswered`; the panel shows what it can.

Over a mirror the reads and actions can fail with a `HostRequestError`, so the core's error channels include it. `syncFailures` is a point-in-time read of the engine's recent terminal sync failures (oldest first), which the Svelte panel re-reads on every event and every few seconds. `events` follows the host's event stream again after a host restart.

## Usage

```ts
import * as Devtools from "@thomasfosterau/legation-devtools";

// `engine`/`store` are the same values you provided to `ClientEngine.make`.
const devtools = Devtools.make(engine, store, {
  // Optional: wires the "simulated offline" action. Build `offline` with
  // `Transport.simulateOffline` and wrap your real transport with it.
  offline: { setOffline, isOffline },
});
```

Svelte:

```svelte
<script lang="ts">
  import { DevtoolsPanel } from "@thomasfosterau/legation-devtools/svelte";
</script>

<DevtoolsPanel core={devtools} />
```

Over a mirror, in the worker that hosts the engine and in the tab:

```ts
import * as Devtools from "@thomasfosterau/legation-devtools";
import { Mirror } from "@thomasfosterau/legation/internal";
import { BroadcastMirrorChannel, ServiceWorkerHost } from "@thomasfosterau/legation-browser";

// Worker: serve the devtools kinds beside core's introspection kinds.
yield * ServiceWorkerHost.run({ requests: Devtools.hostRequests(engine, store) });

// Tab: the same core shape, over a `Mirror` on the host's channel. A tab whose
// `Client` connected to the worker can open one of its own for devtools.
const mirror =
  yield *
  Mirror.make({
    channel: yield * BroadcastMirrorChannel.make("legation"),
    mutators,
  });
const devtools = Devtools.fromMirror(mirror);
```

The `/svelte` entry point is a separate export so an app that never imports
it pays nothing for the panel in its production bundle. The headless core is
framework-agnostic — a binding for another framework is a component over the
same `DevtoolsCore`.

Note: `@thomasfosterau/legation-devtools/svelte` ships raw `.svelte`/`.ts` source (not a
pre-compiled bundle) — any Svelte 5 app already has a bundler that compiles
`.svelte` files, so this composes directly with your app's own build.

## License

MIT
