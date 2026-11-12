# @thomasfosterau/legation-svelte

Idiomatic Svelte bindings for the
[`@thomasfosterau/legation`](../effect) engine.

Coming from TanStack Query / SwiftData / SWR? [Coming from TanStack Query](../../docs/comparisons/coming-from-tanstack-query.md) maps those libraries' concepts onto this model.

The package is deliberately thin. Everything the engine can do on its own —
reads, mutations, hydration — is `@thomasfosterau/legation`; what lives here is the
Svelte shape of it, plus the two integrations a framework can do that the core
cannot: **reactive re-subscription** (a read re-runs when the `$state` its
thunk touches changes) and **SSR hydration** (a server-rendered page's rows
seeding the first client render).

Two entry points:

| Import                                | What it is                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `@thomasfosterau/legation-svelte`     | `createClient` / `setClient` plus every hook — reads, aggregates, mutations, undo       |
| `@thomasfosterau/legation-svelte/kit` | the SvelteKit surface: client-group cookie, SSR snapshot `load`, snapshot-hydrated boot |

## Install

```sh
npm install @thomasfosterau/legation-svelte @thomasfosterau/legation effect svelte
```

`@sveltejs/kit` is an **optional** peer dependency (`^2.0.0 || ^3.0.0`) — only
`@thomasfosterau/legation-svelte/kit` needs it, and only as a `Cookies` type, so a non-Kit
Svelte app pulls nothing.

## Effect version

Peers `effect ^4.0.0`, as its dependency `@thomasfosterau/effect-svelte` (0.6.1 and later) does. Tested against `4.1.2` (the version CI pins) and `4.0.0` (the floor; checked by hand, not in CI, before 1.0); install one copy of `effect` in your app (ADR-0003).

## Booting the Client

`createClient` takes `Client.make`'s options and returns a handle; `setClient`
puts it in context for every hook below it. The app builds no Effect runtime
and imports nothing from `effect` to boot:

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { createClient, setClient } from "@thomasfosterau/legation-svelte";
  import { mutations, nodes } from "$lib/domain";

  // No Client during SSR: the hooks render from their seeds there.
  const client =
    typeof document !== "undefined"
      ? createClient({ nodes, mutations, transport: { url: location.origin } })
      : undefined;
  setClient(client);
  onDestroy(() => void client?.dispose());
</script>
```

- **`client.dispose()`** releases the Client: its sync loop stops and its store
  and transport close. Call it when the app tears down; a second call does
  nothing more.
- **On the server, pass no Client** (`setClient(undefined)`). Every hook then
  renders from its `initial` seed, and only a hook that actually reaches for
  the Client (a write, a read with no seed) fails, with `ClientUnavailable`.
  No stand-in runtime is needed.
- **An engine hosted elsewhere** (a service worker, an elected tab): pass a
  `channel` instead of a transport, `createClient({ nodes, mutations, channel:
  BroadcastMirrorChannel.make(name) })`, and the Client is a mirror of that
  engine. Pass the page's `snapshot` too and the host hydrates its store with
  it (see [With the engine in a service worker](#with-the-engine-in-a-service-worker)).
- **Custom layers** (an in-page server, a simulated-offline transport, the
  Kit's snapshot-hydrated `clientRuntime`):
  build the `ManagedRuntime` yourself and pass `setClient(fromRuntime(runtime))`,
  or `setClientRuntime(runtime)`, which is the same thing. `getClient()` returns
  the handle in context (`Option`), and `client.runtime` is the runtime the
  hooks run over, for Effect code that needs the Client directly.

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

- **`useQuery(() => read)`** / **`useAnswer(() => read)`** /
  **`useNamedQuery(() => ({ name, args }))`** —
  a declarative `Query.Read`; `include`d edges resolve onto each row's
  `related`, so a join needs no separate hook. The thunk may return
  `undefined` to opt out of reading entirely — no window is registered and
  no request is issued, and `current` stays at its initial state rather than
  becoming a successful empty result. Every hook below that takes a read
  thunk (`useConnection`, `useAggregate`, `useAggregateGrouped` included)
  supports the same opt-out.
  The rows are typed from the read and the app's registered graph (see
  [Typed rows](#typed-rows)). `useAnswer` gives the same rows with their
  completeness beside them (see below).
- **`useConnection(() => read, { pageSize })`** — connection-style paging that
  _grows_ one window rather than jumping between detached pages.
- **`useAggregate(() => read, agg)`** / **`useAggregateGrouped(() => read, agg, groupBy)`**
- **`useMutation()`** / **`useMutationWithAck()`** — a promise-returning
  `mutate(name, args)`, optimistic on resolve; the `WithAck` form settles with
  the backend's authoritative outcome.
- **`useMutationState(() => mutator?)`** — every journaled mutation's lifecycle.
- **`useUndo(manager)`** — `canUndo` / `canRedo` / `undo` / `redo` over an
  `Undo.UndoManager`.
- **`setClient(client)`** / **`getClient()`** — the `Client` in Svelte context
  (see [Booting the Client](#booting-the-client)). Call `setClient` once, high
  in the tree, before any hook. `setClientRuntime(runtime)` /
  `getClientRuntime()` are the same over a runtime the app built itself.

Every live hook accepts `{ initial }` to seed a synchronous `Success` before
the first emission — during SSR (where `$effect` never runs) the seed is what
renders, and on the client it makes the first render match the server markup
(no loading flash).

```svelte
<script lang="ts">
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@thomasfosterau/legation-svelte";

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

### Typed rows

Register the app's node graph once, next to it, and declare reads
`as const satisfies Query.Read`; `useQuery`, `useAnswer` and `useConnection`
then type every row with no cast and no type argument:

```ts
// src/lib/domain.ts
import { Edge, Node, type Query } from "@thomasfosterau/legation";

export const nodes = Node.registry([products, sellers, variants]);

declare module "@thomasfosterau/legation" {
  interface Register {
    readonly nodes: typeof nodes;
  }
}

export const allProducts = {
  collection: "products",
  order: ["name"],
  include: { seller: true, variants: true },
} as const satisfies Query.Read;
```

```svelte
<script lang="ts">
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@thomasfosterau/legation-svelte";
  import { allProducts } from "$lib/domain";

  const products = useQuery(() => allProducts);
  const rows = $derived(AsyncResult.getOrElse(products.current, () => []));
</script>

{#each rows as row (row.id)}
  <!-- `row.value` is the products row; `seller` is a sellers row or null
       (a `one` edge whose row is absent); `variants` is the variants rows. -->
  {row.value.name} by {row.related.seller?.name ?? "—"}, {row.related.variants.length} variants
{/each}
```

An edge the read does not `include` is not on `row.related`, and a read that
names a collection, edge or field the graph does not declare fails to compile
at the `useQuery` call. Inline reads are typed the same way. A dynamic read
(its `collection` a `string`), or any read with no graph registered, resolves
to untyped rows (`value: unknown`) and is never a compile error. A helper that
takes such rows names them `Client.ResolvedRow<typeof allProducts>` (the
registered graph is the default). `initial` seeds are checked against the
typed rows: `Hydration.rowsFor(snapshot, nodes, read)` produces them typed for
a read with no `include` (a snapshot carries no resolved edges; seed those
yourself, or let the first live emission fill them in).

A read keyed on a selection that starts empty — the common master/detail
case — opts out by returning `undefined` instead of reaching for a sentinel
argument that matches nothing:

```svelte
<script lang="ts">
  let selectedId = $state<string | undefined>(undefined);
  const detail = useQuery(() =>
    selectedId === undefined ? undefined : { collection: "products", where: { id: selectedId } }
  );
</script>
```

While `selectedId` is `undefined`, `detail.current` is `Initial` — no window
is registered and no request is issued — and selecting a row subscribes just
as any other reactive input change would.

`useAnswer(() => read)` is `useQuery` with the answer's completeness beside
its rows (`Client.Answer`: `{ rows, completeness }`, from
`Client.observeAnswers`): `completeness` is `"partial"` while the read's
windows are not pulled yet (offline, or before the first pull), so the device
may hold fewer rows than the server, and `"complete"` once they are. Its read
is checked and its rows typed as `useQuery`'s are, and it opts out the same
way.

```svelte
<script lang="ts">
  import { AsyncResult } from "effect/reactivity";
  import { useAnswer } from "@thomasfosterau/legation-svelte";

  const todos = useAnswer(() => ({ collection: "todos" }));
  const answer = $derived(AsyncResult.getOrElse(todos.current, () => undefined));
</script>

{#if answer?.completeness === "partial"}<p>Showing what this device has synced.</p>{/if}
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
`createContext`. `@thomasfosterau/legation-svelte/kit` is rune-free and server-side, so
importing it pulls none of this in.

## SvelteKit

`@thomasfosterau/legation-svelte/kit` adds what SvelteKit shapes: the client-group cookie, an
SSR snapshot for a server `load`, and the snapshot-hydrated Client boot. The
hydration itself is core (`Hydration` in `@thomasfosterau/legation`) and the wiring is
`Client.make` — this subpath is the framework's share of it, nothing more.
It works with SvelteKit 2 and 3. The samples below import app modules through
Kit 2's `$lib` alias. Kit 3 removes `$lib` in favour of a Node subpath import
declared in the app's `package.json` (`"imports": { "#lib/*": "./src/lib/*" }`),
so there write `#lib/domain.js` instead; or keep `$lib` with the (deprecated)
`alias: { $lib: "src/lib" }` option in the SvelteKit config.

The SSR model (see `Hydration` in `@thomasfosterau/legation`): each server render runs
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
import { loadSnapshot, requestCredentials } from "@thomasfosterau/legation-svelte/kit";
import { allProducts, nodes } from "$lib/domain";

export const load = serverLoad((event) =>
  Effect.gen(function* () {
    const { snapshot, clientGroupId } = yield* loadSnapshot(event.cookies, {
      nodes,
      reads: [allProducts],
      // The request's cookie and headers, for the server's IdentityResolver.
      credentials: requestCredentials(event),
    });
    return { snapshot, clientGroupId };
  })
);
```

- **`clientGroupId(cookies, options?)`** — read-or-mint the browser's client
  group id (a plain, non-`httpOnly` cookie; it carries no authority — identity
  is resolved server-side via `IdentityResolver`).
- **`loadSnapshot(cookies, { nodes, reads, credentials? })`** — resolve the
  group id and produce the page's snapshot over a request-scoped engine (a thin
  wrapper of core's `Hydration.snapshot`). Pass `credentials` so the in-process
  render presents the request's session to the server's `IdentityResolver`;
  without it the render is anonymous (`Authorization.noCredentials`).
- **`requestCredentials(event)`** — the request's headers as
  `Option.some(Authorization.RequestCredentials)`, for `loadSnapshot`'s and
  `runFormMutation`'s `credentials` option. Only the server's resolver reads
  them; they never reach `SyncContext`, middleware or auth filters.

### Client

```ts
// $lib/engine.ts — boot once, hand the runtime to the hooks.
import { clientRuntime } from "@thomasfosterau/legation-svelte/kit";
import { IndexedDbClientStore } from "@thomasfosterau/legation-browser";
import { Identity } from "@thomasfosterau/legation";
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
  import { fromRuntime, setClient } from "@thomasfosterau/legation-svelte";
  const { data, children } = $props();
  setClient(fromRuntime(boot(data)));
</script>
```

Components render SSR markup from the snapshot and hydrate flash-free by
seeding the rune hooks:

```svelte
<script lang="ts">
  import { Hydration } from "@thomasfosterau/legation";
  import { useQuery } from "@thomasfosterau/legation-svelte";
  import { allProducts, nodes } from "$lib/domain";
  const { data } = $props();
  const products = useQuery(() => allProducts, {
    initial: Hydration.rowsFor(data.snapshot, nodes, allProducts),
  });
</script>
```

### With the engine in a service worker

When the engine and its durable store live in a service worker (or an
elected tab), the tab holds the snapshot but not the store, so it hands the
snapshot to the host. `createClient` with a `channel` and a `snapshot` does
it, through the mirror's host-request envelope:

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { createClient, setClient } from "@thomasfosterau/legation-svelte";
  import { BroadcastMirrorChannel, ServiceWorkerHost } from "@thomasfosterau/legation-browser";
  import { mutations, nodes, shellReads } from "$lib/domain";

  const { data, children } = $props();
  const client =
    typeof document !== "undefined"
      ? createClient({
          nodes,
          mutations,
          channel: BroadcastMirrorChannel.make(ServiceWorkerHost.defaultChannelName),
          snapshot: data.snapshot,
          subscribe: shellReads,
        })
      : undefined;
  setClient(client);
  onDestroy(() => void client?.dispose());
</script>
```

- **The host owns the empty-store gate.** It hydrates its store only when
  that store is empty (no rows, no cookie, no journalled or unpulled
  mutations) and its engine has not started a pull. A returning visitor's
  replica is never touched, and of two tabs booting at once the first
  snapshot to arrive wins. A declined snapshot needs no action: the host's
  replica is at least as fresh.
- **The offer goes first.** The Client offers the snapshot before it
  subscribes anything (a registration makes the host pull, and a started pull
  declines the snapshot), and re-sends it every half second while no host
  answers, as when a first visit's service worker is still installing, for at
  most `hydrateTimeout` (default 5 seconds). The hooks are handed the Client
  only after that, so they render from their seeds meanwhile: seed them from
  the snapshot (`initial: Hydration.rowsFor(data.snapshot, nodes, read)`) and
  first paint matches the server's markup.
- **`client.hydration`** is a `Promise` of the host's answer: `Option.some({
  hydrated, reason? })` with `reason` `"NotEmpty"` or `"AlreadyPulling"`, or
  `Option.none()` when there was no snapshot, no host answered, or the host
  does not serve hydration. It is for observability only.
- **The host side.** Start the worker's host with its store in context and a
  `hydrationWindow` (`ServiceWorkerHost.start({ hydrationWindow: "3 seconds" })`
  in `@thomasfosterau/legation-browser`): a worker that boots over an empty
  replica holds its first pull until the first tab's snapshot arrives, so the
  snapshot is not beaten by the sync loop's connect pull. A replica that holds
  state is never held.

### Snapshot or `initial`?

Both put server-rendered rows on the first paint; they differ in what the
client does next.

- **Reach for the snapshot** when the page's data is the engine's own: the
  rows a Client will keep live anyway. The snapshot carries the server's CVR
  cookie, so the client's first pull continues that conversation and fetches
  only what changed since the render. Nothing is fetched twice, and a fresh
  browser's durable replica starts warm. It costs a request-scoped engine and
  a pull per render, against a sync server the renderer can reach.
- **Reach for `initial` seeding** when a page is genuinely simpler served
  from the app's own API: a read with included edges (`Hydration.rowsFor`
  resolves none), a document the no-JS tier already loads, a page that must
  render when the sync server cannot. The seed shows until the live read
  emits, and the client syncs those rows from scratch on its first pull.
- They combine: seed each hook from the snapshot (`Hydration.rowsFor`) where
  it has the read's rows, and from the API elsewhere.

### Form actions run Mutations

A form action that can name the client group runs a named Mutation as one of
that group's mutations (ADR-0030, amendment #215): the same definition the JS
path journals, so a write is authored once. The mechanism is core
(`server.mutate` in `@thomasfosterau/legation`); `/kit` reads the
group cookie and the form's hidden fields, and gives the enhanced submit.

Each rendered form carries a **form client**: a fresh id with mutation id
`1`, minted by the page's `load` and rendered in hidden fields. A resubmission
of the same rendered form is the same mutation, so the ledger applies it once
and the action answers the original ruling.

```ts
// +page.server.ts
import { Effect } from "effect";
import {
  FORM_CLIENT_FIELD,
  FORM_MUTATION_FIELD,
  RECEIPT_KEY,
  formMutationTarget,
  mintFormClient,
  requestCredentials,
  runFormMutation,
} from "@thomasfosterau/legation-svelte/kit";
import { addToCart } from "$lib/domain";
import { server } from "$lib/server/sync";

export const load = () => ({ form: mintFormClient() });

export const actions = {
  add: async (event) => {
    const { cookies, request } = event;
    const data = await request.formData();
    // The form layer (e.g. effect-forms) validates the fields first.
    const args = { productId: String(data.get("productId")) };
    const target = formMutationTarget(cookies, data);
    if (target === undefined) {
      // No client-group cookie: an out-of-band writer, as before.
      return writeThroughApiAndBroadcast(args);
    }
    // The action's session reaches the server's IdentityResolver, as a push's does.
    const receipt = await Effect.runPromise(
      runFormMutation(server, target, addToCart, args, { credentials: requestCredentials(event) })
    );
    return { [RECEIPT_KEY]: receipt };
  },
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    FORM_CLIENT_FIELD,
    FORM_MUTATION_FIELD,
    enhanceFormMutation,
  } from "@thomasfosterau/legation-svelte/kit";
  import { getClientRuntime } from "@thomasfosterau/legation-svelte";
  import { addToCart } from "$lib/domain";
  const { data } = $props();
  const submit = enhanceFormMutation(getClientRuntime(), {
    mutation: addToCart,
    args: (form) => ({ productId: String(form.get("productId")) }),
  });
</script>

<form method="POST" action="?/add" use:enhance={submit}>
  <input type="hidden" name={FORM_CLIENT_FIELD} value={data.form.clientId} />
  <input type="hidden" name={FORM_MUTATION_FIELD} value={data.form.mutationId} />
  <button name="productId" value="p1">Add</button>
</form>
```

- **No JS:** the form posts its rendered form client; the action runs the
  Mutation and the page re-renders from the server.
- **Enhanced:** each submit mints a fresh form client into the posted fields
  and applies the Mutation's local handler to the optimistic overlay under it,
  **without journaling it** (the action delivers it; a push would apply it
  twice). On the receipt, `acknowledged` moves the effect to the unpulled
  tail and `rejected` drops it (`onReceipt` gets the reason). The effect is
  released only by the pull whose `lastMutationIds` covers the form client,
  never on the action's response, exactly as for a pushed mutation. The
  post-action `load` re-run is off by default (`refreshAll: false`); the
  overlay already shows the write. Offline, the submit fails as the network
  does (ADR-0030 open point 6).
- Over a connected host (`Client.connect`, a mirror of a service-worker or
  elected-host engine) the host's engine holds the overlay for every tab. A
  host from a release that predates this answers the submit with a
  `TransportError` rather than leaving it waiting.

**One path per write.** A form-action Mutation and a façade write (#169,
`@thomasfosterau/legation-jsonapi`) are two interception points for the same
intent. Both name the mutation by id, neither fabricates a status the server
did not give, and both release the optimistic effect only when a pull
observes it. A façade write journals a plain `fetch` on the client and
answers `202 pending`; a form-action Mutation runs on the server and answers
the ruling. Write a submission through one of them, never both: the two
deliveries carry different client ids, so the backend would apply the write
twice.

### No-JS baseline for other writers

An action that cannot name the client group (no cookie, another service, a
cron) stays an out-of-band writer (ADR-0019): commit the write through the
app's API, then `server.broadcast({ collection })` for the touched
collections so live subscribers pull. The next full-page render re-snapshots.

## License

MIT
