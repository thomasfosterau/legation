# @legation/sveltekit

SvelteKit integration for the [`@legation/effect`](../effect) engine: SSR
snapshot loading, the client-group cookie, and snapshot-hydrated engine boot.
Pairs with [`@legation/svelte`](../svelte) for the component API.

The SSR model (see `Hydration` in `@legation/effect`): each server render runs
a **request-scoped engine** against the app's sync server, under the
**browser's client group id**, and ships the dehydrated snapshot (rows +
CVR cookie) in the page data. The client hydrates the snapshot into its
durable store **only when the store is empty** — a repeat visit's rows,
cookie, and journalled offline mutations are all fresher — and the first
client pull continues the CVR conversation where the server left off: no
refetch, no reset.

## Server

```ts
// +page.server.ts — with @thomasfosterau/effect-sveltekit's serverLoad (or any
// Effect-based load), the app's sync server provided as ServerHandler.
import { Effect } from "effect";
import { loadSnapshot } from "@legation/sveltekit";
import { allProducts } from "$lib/domain";

export const load = serverLoad((event) =>
  Effect.gen(function* () {
    const { snapshot, clientGroupId } = yield* loadSnapshot(event.cookies, {
      subsets: [allProducts],
    });
    return { snapshot, clientGroupId };
  })
);
```

- **`clientGroupId(cookies, options?)`** — read-or-mint the browser's client
  group id (a plain, non-`httpOnly` cookie; it carries no authority — identity
  is resolved server-side via `IdentityResolver`).
- **`loadSnapshot(cookies, { subsets })`** — resolve the group id and produce
  the page's snapshot over a request-scoped engine (`Hydration.snapshot`).

## Client

```ts
// $lib/engine.ts — boot once, hand the runtime to @legation/svelte.
import { engineRuntime } from "@legation/sveltekit";
import { IndexedDbClientStore } from "@legation/browser";

export const boot = (data: { snapshot: Snapshot; clientGroupId: string }) =>
  engineRuntime({
    engine: { clientId, clientGroupId: data.clientGroupId, mutators },
    store: IndexedDbClientStore.layerWindow(),
    transport: rpcTransportLayer,
    snapshot: data.snapshot,
  });
```

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { setEngineRuntime } from "@legation/svelte";
  const { data, children } = $props();
  setEngineRuntime(boot(data));
</script>
```

Components render SSR markup from the snapshot and hydrate flash-free by
seeding the rune hooks:

```svelte
<script lang="ts">
  import { Hydration } from "@legation/effect";
  import { useQuery } from "@legation/svelte/runes";
  const { data } = $props();
  const products = useQuery(() => allProducts, {
    initial: Hydration.rowsFor(data.snapshot, allProducts),
  });
</script>
```

## No-JS baseline

Writes without JavaScript are ordinary SvelteKit form actions hitting the
app's own API — out-of-band writers in engine terms (ADR-0019): commit the
write, then `InvalidationBus.publish` the touched collections so live
subscribers pull. The next full-page render re-snapshots.

```bash
npm install @legation/sveltekit @legation/effect effect @sveltejs/kit
```
