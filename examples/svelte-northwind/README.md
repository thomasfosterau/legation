# legation · SvelteKit · Northwind

A relational admin dashboard over the classic Northwind dataset, driving
[`@legation/effect`](../../packages/effect) through the
[`@legation/svelte`](../../packages/svelte) bindings on SvelteKit. Like the
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
- **Seven collections, joined incrementally.** The order list (orders ⋈
  customers ⋈ employees ⋈ rolled-up line items), the category product-counts and
  the customer order-counts are `Derive` join/groupBy pipelines
  (`@legation/effect`'s client-local query tier, ADR-0027) that the engine
  maintains **from row deltas** — not `Map`-joins re-run on every render. They
  reach Svelte through the same `observe`→`Readable` bridge `query` uses, so the
  bindings needed nothing new. A derived view only ever sees already-synced
  rows; it never widens what syncs.
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
src/lib/          domain, sync world, seed data, data stores, actions
src/routes/       +layout.ts (builds the world once) + one folder per screen
```

- `src/lib/domain.ts` — the seven collections, mutator contracts, and subsets.
- `src/lib/sync.ts` — `createWorld()`: wires the whole stack, then exposes the
  engine `runtime` plus the demo side-channel (offline toggle, devtools core).
- `src/lib/data.ts` — the base collection stores and the `Derive` views, shared
  via context so every screen reads the same live stores.
- `src/routes/+layout.ts` — the root `load`: builds the world **once** for the
  lifetime of the app, and turns SSR off.
- `src/routes/+layout.svelte` — the shell: sync banner, nav, devtools panel.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/svelte-northwind
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
