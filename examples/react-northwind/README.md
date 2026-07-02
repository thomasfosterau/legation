# legation · React · Northwind Traders

The classic [Northwind](https://en.wikipedia.org/wiki/Northwind_Database) sales
dataset as a small admin dashboard, driving
[`@legation/effect`](../../packages/effect) from React through the
[`@legation/react`](../../packages/react) bindings. Where the
[Conduit example](../react-realworld) shows relationships + auth, Northwind
leans on **many collections and the joins between them**, plus optimistic edits.

## What it shows

- **Seven collections, joined live over the mirror.** `categories`,
  `suppliers`, `products`, `customers`, `employees`, `orders`, and
  `orderDetails` are independent typed collections. The dashboard's views — a
  product with its category and supplier, an order with its customer, employee
  and computed line-item total, category/customer counts — are assembled in
  `data.ts` as reactive `useMemo` joins over the live `useQuery` results, so
  they re-derive on every edit and rebase.
- **Optimistic edits with read-merge mutators.** Editing a product's
  price/stock/discontinued, or shipping an order, sends only the changed fields;
  the `product/update` and `order/ship` mutators **read the current row first**
  (`writer.get`) on both the client overlay and the authoritative backend, merge,
  and put — idempotent across rebases. Creating/deleting products and creating
  categories show plain create/delete intents.
- **Client-side search, category filter, and pagination** over the synced
  `products` collection.
- **Offline-first.** The status banner toggles the transport offline: edits
  queue in the durable journal and flush on reconnect.
- The whole thing runs the real in-page pipeline (`SyncServer` +
  `MemoryBackend` + `CvrStore` + `InvalidationBus`) over a `localStorage` store.

## Layout

- `src/domain.ts` — the seven collections, the mutator contracts, and the
  subsets subscribed on boot.
- `src/seed.ts` — a representative slice of the Northwind data.
- `src/sync.ts` — `createWorld()`: the in-page pipeline, the (read-merge) backend
  handlers, and the seed. Returns the engine `runtime` + demo controls.
- `src/data.ts` — the relational read layer (client-side join hooks).
- `src/actions.ts` — the write surface over `useMutation`.
- `src/world.tsx` — context for the demo controls (offline, connection).
- `src/pages/*`, `src/App.tsx` — the tabbed dashboard UI.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/react-northwind
bun run dev      # open the printed http://localhost:5178
```

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed reappears). The _client_ journal is durable.
- The example is a workspace member for dependency consistency but stays outside
  the CI quality gates, like the other examples; it is illustrative, not a
  published package.
