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
executor, and the public/private auth split (anonymous catalog sync, empty
private allow-sets, forged-identity rejection, the `order/place` round trip
with stock decrement and cart clear).

## Deliberate next steps

- Host the engine in the service worker with tab mirrors over `ClientView`
  (ADR-0010/0021) — the binding-level proof already exists in
  `@legation/svelte`'s mirror test.
- Swap the demo sign-in for Better Auth behind the same `client_groups` +
  `IdentityResolver` seam.
- An SSR-stub runtime helper for `@legation/svelte/kit` (see `lib/engine.ts`).
