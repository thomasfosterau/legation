# legation · SvelteKit · Commerce

A SvelteKit commerce catalog that drives the legation engine the way a real
product would — **a stress harness first, a showcase second**. Everything is
a progressive enhancement over server-rendered pages: with JavaScript
disabled the app still browses, signs in, and adds to the cart; with JS it
becomes offline-first and live.

## What it exercises

| App feature | Library path |
| --- | --- |
| SSR pages with no loading flash | `Hydration.snapshot` per request (request-scoped engine over the in-process `ServerHandler`), `hydrateIfEmpty` on boot, rune hooks' `initial` seeded by `Hydration.rowsFor` — the snapshot's cookie continues the CVR conversation on the first client pull (no reset) |
| Public catalog + private cart/orders | deny-by-default auth: `allowAll` for catalog collections, identity-scoped allow-sets for private ones (ADR-0015), `IdentityResolver` reading the `client_groups` binding written at sign-in — identity is never client-asserted (a forged `userId` push is permanently rejected) |
| Product page joins (variants, reviews, seller), cart lines → variants | declared relationships + `useRelated` (live, incrementally-maintained joins over the mirror) |
| Category filter + pagination | reactive rune-hook inputs re-subscribing typed subsets; cursor+limit windows (`Subset.window`) on both tiers |
| Instant writes, offline queueing | named mutators journaled + optimistic overlay; `order/place` recomputed server-side from the authoritative cart (conflict resolution is replay, ADR-0008) |
| Live sync over WebSockets, degrading to HTTP | `RpcTransport` over WS (`/sync-ws`) with `Transport.withFallback` to plain HTTP POST (`/sync`), `withBrowserConnectivity` folding in `navigator.onLine` |
| No-JS writes | plain form actions calling the sync server's `/api` surface (an Effect v4 `HttpApi`, consumed through the derived `HttpApiClient`) — out-of-band writers committing where the invalidation bus lives (ADR-0019), with `PollingHintSource` (tier 2) as the safety net |
| Order-status notifications | a non-UI live-query consumer watching `orders`; the fulfilment worker advances statuses out-of-band on the sync server |
| Durable storage | `SqlBackend` over Effect's SQL packages (`@effect/sql-sqlite-node`'s `SqlClient`; the `SqlExecutor` seam is a thin adapter) that **passes `verifyBackendContract`** (see `tests/`); client side on IndexedDB |
| HTTP cache | the service worker serves assets cache-first and pages stale-while-revalidate via `CacheApiHttpCache` |

## Running it

```bash
bun install && bun run build          # workspace root: build the packages
cd examples/commerce
bun run dev:server                    # the sync server (WS + HTTP, port 3100)
bun run dev                           # the SvelteKit app (port 5178, proxies /sync*)
```

Sign in with any username (demo auth — the point is the `IdentityResolver`
seam, not the credential ceremony). Try: two browsers with different users;
DevTools offline while adding to cart, then reconnect; killing the sync
server (calls degrade WS→HTTP first, then queue); a no-JS browser.

## Tests

`bun run test` (from this directory) runs the app's server-side suites in
the workspace runner: the ADR-0009 contract verification of the SQLite
executor, the public/private auth split (anonymous catalog sync, empty
private allow-sets, forged-identity rejection, the `order/place` round trip
with stock decrement and cart clear), and the atomic operations endpoint
(all-or-nothing batches, `lid` resolution, identity, and a `JsonApiBackend`
pushing through it as one request per batch).

## Atomic operations

Besides the per-resource endpoints, the JSON:API serves the
[atomic operations extension](https://jsonapi.org/ext/atomic/) at
`POST /jsonapi/operations` (`Endpoint.operations` over `reviews`,
`cartItems` and `orders`). One request carries an ordered batch of `add` /
`update` / `remove` operations; the batch is applied inside one SQL
transaction under the same authoritative rules as the sync mutators and the
REST write handlers — identity from the header (never the payload), a
review's `userId` is the caller, a cart add checks the variant's stock, updates
and removes only touch the caller's own rows, an order is recomputed from the
authoritative cart. Relationship operations are not supported.

- **Media type.** Requests and responses carry the extension parameter:
  `Content-Type: application/vnd.api+json; ext="https://jsonapi.org/ext/atomic"`
  (and the same `Accept`). The content-negotiation middleware is provided once
  with the extension declared (`Middleware.layerWith`), which still accepts a
  bare `application/vnd.api+json` on the ordinary endpoints.
- **Identity.** The same `x-commerce-user` header contract as every other
  user-scoped endpoint — set by the SvelteKit process after it resolves the
  session.
- **Ids and lids.** effect-jsonapi 0.12's typed `add` operation has no `id`
  member, so a client-generated id is recovered from the raw request document
  (as `@legation/jsonapi`'s atomic push always sends one). An `add` without an
  id gets a server id; give it a `lid` and later operations in the same batch
  can reference it (`{ "op": "update", "data": { "type": "reviews", "lid": "…" } }`).
- **Rejection contract.** The first failing operation aborts the transaction —
  nothing from earlier operations persists — and the response is a single
  JSON:API error document whose one error carries
  `source.pointer = /atomic:operations/<index>` of the failing operation:
  `401` with no identity, `404` for a missing (or someone else's) row, `409`
  for a client id that names another user's row, `422` for a business rule
  (insufficient stock, rating out of range, unsupported operation). A
  statement failure is a `500`, which a pushing client treats as transient.
- **Success.** A `200` `atomic:results` document with one entry per operation
  (the resource for `add` / `update`, empty for `remove`), and every touched
  collection is `broadcast` once so live sync clients are poked.

`@legation/jsonapi`'s `JsonApiSync.inspect` detects the endpoint from the api,
so a `JsonApiBackend` over this server pushes each journal batch as one
all-or-nothing request, drops a pointer-named rejection as a permanent
rejection of that mutation, and resends the rest.

## Deliberate next steps

- Host the engine in the service worker with tab mirrors over `ClientView`
  (ADR-0010/0021) — the binding-level proof already exists in
  `@legation/svelte`'s mirror test.
- Swap the demo sign-in for Better Auth behind the same `client_groups` +
  `IdentityResolver` seam.
- An SSR-stub runtime helper for `@legation/svelte/kit` (see `lib/engine.ts`).
