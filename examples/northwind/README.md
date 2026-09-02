# legation · SvelteKit · Northwind

A relational admin dashboard over the classic Northwind dataset, driving
[`@legation/effect`](../../packages/effect) through the
[`@legation/svelte`](../../packages/svelte) **rune hooks** on SvelteKit. Like the
other client-only examples it runs the **real library server pipeline in the
page** (`SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`) over a
durable `localStorage` client store.

The whole world — engine, durable store, demo backend — is browser-only, so the
app is a SvelteKit **SPA**: `ssr = false` in the root layout and
`adapter-static` with a fallback page.

## What it shows

- **A route per screen.** `/products`, `/categories`, `/orders`, `/customers`,
  `/suppliers` — the nav is plain links and the URL is the app's state, so a
  screen is reloadable and deep-linkable. `/` redirects to `/products`.
- **Seven nodes, and the joins live in the reads.** The graph declares each
  foreign key once (`Edge.one(..., { via })`) and names the inverse
  (`Edge.many(..., { inverse })`), so a screen asks for what it needs in its
  read: `allOrders` `include`s `customer`, `employee` and `lines`;
  `allProducts` `include`s `category` and `supplier`; a category's product
  count and a customer's order count *are* the `include`d edge. There is no
  client-side join layer at all — no `Map` lookups, no `Derive` pipelines, just
  `row.related`.
- **A reactive read.** Expanding an order reads that order's line items — with
  each line's `product` resolved — through a `useQuery` whose thunk closes over
  the open row id, so opening another order re-subscribes while the previous
  rows stay on screen.
- **Read-merge mutators.** Editing a product's price/stock or shipping an order
  issues a mutator that merges into the existing row, so concurrent edits to
  other fields survive rebase.
- **Search, filter, pagination** over the products grid, all client-local.
- **The devtools panel** (`@legation/devtools`) — this is the owned-engine case
  the panel supports: the app constructs its own `ClientEngine` + `ClientStore`
  in-process.
- **True offline** — the banner's toggle makes the transport *fail* push/pull,
  so edits pile up in the durable journal and flush on reconnect.

## Layout

```
src/lib/          domain (nodes/edges/reads), sync world, seed data, view shaping
src/routes/       +layout.ts (builds the world once) + one folder per screen
```

- `src/lib/domain.ts` — the seven nodes and their edges, the mutation
  contracts with their optimistic handlers, and the reads each screen uses.
- `src/lib/sync.ts` — `createWorld()`: the app `Layer` and the `ManagedRuntime`
  over it, exposing the `Client` runtime plus the demo side-channel (offline
  toggle, devtools core).
- `src/lib/data.ts` — pure functions that shape resolved rows for a screen. No
  stores, no context, no subscriptions: each screen calls `useQuery` itself and
  the Client's window ledger refcounts what they share.
- `src/routes/+layout.ts` — the root `load`: builds the world **once** for the
  lifetime of the app, and turns SSR off.
- `src/routes/+layout.svelte` — the shell: sync banner, nav, devtools panel.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/northwind
bun run dev      # open the printed http://localhost:5179
```

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed rows reappear). The _client_ is durable: pending
  offline writes survive reloads and flush on the next connect.
- The example is a workspace member for dependency consistency. It is excluded
  from the root `tsc` project, oxlint, and prettier (it is illustrative, not a
  published package), but CI does run its `check` script via
  `bun run typecheck:examples`.
