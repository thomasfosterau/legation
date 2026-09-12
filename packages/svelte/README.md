# @legation/svelte

Idiomatic Svelte bindings for the
[`@legation/effect`](../effect) engine.

Coming from TanStack Query / SwiftData / SWR? [Coming from TanStack Query](../../docs/comparisons/coming-from-tanstack-query.md) maps those libraries' concepts onto this model.

The package is deliberately thin. Everything the engine can do on its own —
reads, mutations, hydration — is `@legation/effect`; what lives here is the
Svelte shape of it, plus the two integrations a framework can do that the core
cannot: **reactive re-subscription** (a read re-runs when the `$state` its
thunk touches changes) and **SSR hydration** (a server-rendered page's rows
seeding the first client render).

Two entry points:

| Import                 | What it is                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `@legation/svelte`     | `setClientRuntime` plus every hook — reads, aggregates, mutations, undo                 |
| `@legation/svelte/kit` | the SvelteKit surface: client-group cookie, SSR snapshot `load`, snapshot-hydrated boot |

```bash
npm install @legation/svelte @legation/effect effect svelte
```

`@sveltejs/kit` is an **optional** peer dependency — only `@legation/svelte/kit`
needs it, and only as a `Cookies` type, so a non-Kit Svelte app pulls nothing.

## The hooks

The package root is the whole read/write surface — the hooks are the API, so
they are not behind a subpath. Each hook takes its
inputs as a **thunk** called inside `$effect`, so a read re-subscribes whenever
the reactive state the thunk touches changes — a paginated read whose cursor
lives in `$state` just works, and so does a detail read keyed on a route param.
Results are exposed as a reactive `current`
[`AsyncResult`](https://effect.website) (the engine's atom vocabulary): while
re-subscribing the previous value stays visible with `waiting: true`
(stale-while-revalidate).

- **`useQuery(() => read)`** / **`useNamedQuery(() => ({ name, args }))`** —
  a declarative `Query.Read`; `include`d edges resolve onto each row's
  `related`, so a join needs no separate hook.
- **`useConnection(() => read, { pageSize })`** — connection-style paging that
  _grows_ one window rather than jumping between detached pages.
- **`useAggregate(() => read, agg)`** / **`useAggregateGrouped(() => read, agg, groupBy)`**
- **`useMutation()`** / **`useMutationWithAck()`** — a promise-returning
  `mutate(name, args)`, optimistic on resolve; the `WithAck` form settles with
  the backend's authoritative outcome.
- **`useMutationState(() => mutator?)`** — every journaled mutation's lifecycle.
- **`useUndo(manager)`** — `canUndo` / `canRedo` / `undo` / `redo` over an
  `Undo.UndoManager`.
- **`setClientRuntime(runtime)`** / **`getClientRuntime()`** — the `Client` in
  Svelte context. Call `setClientRuntime` once, high in the tree, before any
  hook.

Every live hook accepts `{ initial }` to seed a synchronous `Success` before
the first emission — during SSR (where `$effect` never runs) the seed is what
renders, and on the client it makes the first render match the server markup
(no loading flash).

```svelte
<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useQuery } from "@legation/svelte";

  let cursor = $state<string | undefined>(undefined);
  const page = useQuery(() => ({
    collection: "products",
    order: ["id"],
    first: 20,
    ...(cursor === undefined ? {} : { after: cursor }),
  }));
  const rows = $derived(AsyncResult.getOrElse(page.current, () => []));
</script>
```

### Async Svelte

Every live hook also exposes an awaitable **`promise`** for Svelte's
`experimental.async` mode: it stays pending until the first data arrives —
so `await` inside a `<svelte:boundary>` renders the boundary's `pending`
snippet — and is replaced with an already-resolved promise on every
emission, so awaiting expressions re-run with fresh rows while Svelte keeps
the previous UI on screen (no pending flash after first load). A failed
stream rejects it into the boundary's `failed` snippet.

```svelte
<svelte:boundary>
  <ul>
    {#each await page.promise as row (row.id)}
      <li>{row.value.name}</li>
    {/each}
  </ul>
  {#snippet pending()}<p>Loading…</p>{/snippet}
</svelte:boundary>
```

The root entry ships as an uncompiled `.svelte.js` module (compiled by your
bundler's Svelte plugin, the standard Svelte-library convention — the package
carries a `svelte` export condition so the plugin picks it up). It requires
Svelte 5.40+: the hooks are runes, and the runtime context rides Svelte's
`createContext`. `@legation/svelte/kit` is rune-free and server-side, so
importing it pulls none of this in.

## SvelteKit

`@legation/svelte/kit` adds what SvelteKit shapes: the client-group cookie, an
SSR snapshot for a server `load`, and the snapshot-hydrated Client boot. The
hydration itself is core (`Hydration` in `@legation/effect`) and the wiring is
`Client.make` — this subpath is the framework's share of it, nothing more.

The SSR model (see `Hydration` in `@legation/effect`): each server render runs
a **request-scoped engine** against the app's sync server, under the
**browser's client group id**, and ships the dehydrated snapshot (rows +
CVR cookie) in the page data. The client hydrates the snapshot into its
durable store **only when the store is empty** — a repeat visit's rows,
cookie, and journalled offline mutations are all fresher — and the first
client pull continues the CVR conversation where the server left off: no
refetch, no reset.

### Server

```ts
// +page.server.ts — with @thomasfosterau/effect-sveltekit's serverLoad (or any
// Effect-based load), the app's sync server provided as ServerHandler.
import { Effect } from "effect";
import { loadSnapshot } from "@legation/svelte/kit";
import { allProducts, nodes } from "$lib/domain";

export const load = serverLoad((event) =>
  Effect.gen(function* () {
    const { snapshot, clientGroupId } = yield* loadSnapshot(event.cookies, {
      nodes,
      reads: [allProducts],
    });
    return { snapshot, clientGroupId };
  })
);
```

- **`clientGroupId(cookies, options?)`** — read-or-mint the browser's client
  group id (a plain, non-`httpOnly` cookie; it carries no authority — identity
  is resolved server-side via `IdentityResolver`).
- **`loadSnapshot(cookies, { nodes, reads })`** — resolve the group id and
  produce the page's snapshot over a request-scoped engine (a thin wrapper of
  core's `Hydration.snapshot`).

### Client

```ts
// $lib/engine.ts — boot once, hand the runtime to the hooks.
import { clientRuntime } from "@legation/svelte/kit";
import { IndexedDbClientStore } from "@legation/browser";
import { Identity } from "@legation/effect";
import { mutations, nodes, shellReads } from "$lib/domain";

export const boot = (data: {
  snapshot: Snapshot;
  clientGroupId: string;
  identity: Identity.Fingerprint;
}) =>
  clientRuntime({
    nodes,
    mutations,
    clientGroupId: data.clientGroupId,
    store: IndexedDbClientStore.layerWindow({ identity: data.identity }),
    transport: rpcTransportLayer,
    snapshot: data.snapshot,
    subscribe: shellReads,
  });
```

> **Pass an `identity`.** A durable replica belongs to exactly one resolved
> identity, and an identity change is a reset, not a rebase (CONTEXT.md,
> "Identity boundary"). Without it, a multi-tenant app on a shared device
> boots the next person onto the last person's private rows — the replica is
> the freshest thing on the machine, and nothing else in the engine has a
> reason to distrust it. The value is an **opaque fingerprint** the app
> computes — a hash of the session subject, never PII and never a credential —
> and `Identity.anonymous` while nobody is signed in, so the first sign-in is
> recognised as the one benign upgrade and keeps its warm replica. Call
> `client.reset(fingerprint)` when the session changes mid-page.
>
> For a device with two regular users, `IndexedDbClientStore.layerNamespaced`
> gives each principal its own replica instead, so switching back costs no
> re-pull.

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { setClientRuntime } from "@legation/svelte";
  const { data, children } = $props();
  setClientRuntime(boot(data));
</script>
```

Components render SSR markup from the snapshot and hydrate flash-free by
seeding the rune hooks:

```svelte
<script lang="ts">
  import { Hydration } from "@legation/effect";
  import { useQuery } from "@legation/svelte";
  import { allProducts, nodes } from "$lib/domain";
  const { data } = $props();
  const products = useQuery(() => allProducts, {
    initial: Hydration.rowsFor(data.snapshot, nodes, allProducts),
  });
</script>
```

### No-JS baseline

Writes without JavaScript are ordinary SvelteKit form actions hitting the
app's own API — out-of-band writers in engine terms (ADR-0019): commit the
write, then `server.broadcast({ collection })` for the touched collections so
live subscribers pull. The next full-page render re-snapshots.
