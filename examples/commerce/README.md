# legation · SvelteKit · Commerce

A SvelteKit commerce catalog that drives the legation engine the way a real
product would — **a stress harness first, a showcase second**. Everything is
a progressive enhancement over server-rendered pages: with JavaScript
disabled the app still browses, signs in, and adds to the cart; with JS it
becomes offline-first and live.

## What it exercises

| App feature                                                 | Library path                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSR pages with no loading flash                             | the loads read the JSON:API at the **canonical URL** of the read the page keeps live (`JsonApiQuery.canonical`), rune hooks' `initial` seeded from those documents — the SSR request and the tab's subscription are one string (ADR-0029 §2)                                                                                                    |
| One read path for REST and sync                             | every `list` / `get` endpoint is **derived** (`RestHandlers`, #163): the URL is the filter grammar (ADR-0028), parsed once into a `Query.Read`, run through `Query.plan` → `authorize` → `SqlBackend.evaluate` — the pull path — and serialised by `DocumentWriter`; the REST resources and the node graph agree declaration for declaration      |
| Public catalog + private cart/orders                        | deny-by-default auth: `allowAll` for catalog collections, identity-scoped allow-sets for private ones (ADR-0015), `IdentityResolver` reading the `client_groups` binding written at sign-in — identity is never client-asserted (a forged `userId` push is permanently rejected); the REST tier scopes by the same policy, no `WHERE userId` anywhere |
| Product page joins (variants, seller), cart lines → variants | declared edges + `include=` (live, incrementally-maintained joins over the mirror); reviews are their own windowed collection read (`useConnection`), not a product edge                                                                                                                                                                        |
| Category filter + pagination                                | `?category=` and `?after=` in the page URL: plain links for the no-JS tier, reactive rune-hook inputs re-subscribing typed subsets for the enhanced one; cursor+limit windows (`Subset.window`) on both tiers — `page[limit]` / `page[after]` and `links.next` on REST                                                                          |
| Instant writes, offline queueing                            | named mutators journaled + optimistic overlay; `order/place` recomputed server-side from the authoritative cart (conflict resolution is replay, ADR-0008)                                                                                                                                                                                       |
| Live sync over WebSockets, degrading to HTTP                | `RpcTransport` over WS (`/sync-ws`) with `Transport.withFallback` to plain HTTP POST (`/sync`), `withBrowserConnectivity` folding in `navigator.onLine`                                                                                                                                                                                         |
| No-JS writes                                                | plain form actions calling the sync server's JSON:API write endpoints (an Effect v4 `HttpApi`, consumed through the derived `HttpApiClient`) — out-of-band writers committing where the invalidation bus lives (ADR-0019), with `PollingHintSource` (tier 2) as the safety net                                                                  |
| Order-status notifications                                  | a non-UI live-query consumer watching `orders`; the fulfilment worker advances statuses out-of-band on the sync server                                                                                                                                                                                                                          |
| Durable storage                                             | `SqlBackend` over Effect's SQL packages (`@effect/sql-sqlite-node`'s `SqlClient`; the `SqlExecutor` seam is a thin adapter) that **passes `verifyBackendContract`** (see `tests/`); client side on IndexedDB                                                                                                                                    |
| HTTP cache                                                  | the service worker serves assets cache-first and pages stale-while-revalidate via `CacheApiHttpCache`                                                                                                                                                                                                                                          |
| Plain `fetch` served from the replica                       | the **façade** (ADR-0029, `JsonApiFacade.fetchHandler` composed first in `src/service-worker.ts`): the catalog load is universal (`src/routes/+page.ts`), so on client navigation its plain `fetch` of a canonical URL is intercepted in the worker and answered from the replica when the shell's pins cover it (`x-legation-served-at`); uncovered goes to the network, offline and uncovered is the 503 `offline` document; a pending cart write shows in a covered response (`tests/facade-browser.test.ts`) |

## The JSON:API

`server/resources.ts` declares the resources, `server/jsonapi.ts` the
endpoints. Reads are derived from the node graph in `src/lib/domain.ts`, so a
URL is the filter grammar over each node's **filterable set** (`id` and the
`one`-edge keys by `eq` / `in`; `userId` by `eq` on the private collections;
`sort` by `id`, `name` on categories, `createdAt` on reviews and orders):

```text
GET /jsonapi/products?filter[categoryId]=c-audio&sort=id&page[limit]=4       # the catalog page
GET /jsonapi/products?include=seller%2Cvariants&filter[id]=p-01              # a product's detail read
GET /jsonapi/products/p-01?include=variants                                  # the same, as a single resource
GET /jsonapi/reviews?filter[productId]=p-01&sort=-createdAt                  # a product's reviews, newest first
GET /jsonapi/cartItems?include=variant&filter[userId]=u1                     # the cart (x-commerce-user: u1)
GET /jsonapi/orders?filter[userId]=u1&sort=-createdAt                        # the orders
GET /jsonapi/products?fields[products]=name&sort=id                          # a sparse fieldset
GET /jsonapi/products?filter[priceCents][gt]=abc                             # 400: not a filterable field
```

The documents carry `links.self` (the request's canonical string) and, for a
full page, `links.next` (`page[after]` at the last row's id). A URL outside
the grammar — an undeclared field, an operator the field does not admit, a
literal of the wrong kind, an unsortable field, an edge no node has — is a
400 error document whose `source.parameter` names the key, before any
database call. A private collection read without identity is empty (the
policy's empty allow-set), never a 401: the loads guard sign-in themselves.
Each endpoint declares its query as the graph's own codec
(`JsonApiQuery.querySchema` for a `list`, `singleRowSchema` for a `get`), so
the api's contract and the handler's parse are one grammar. The writes (`create` / `delete`) stay hand-written SQL that
`broadcast`s its hints.

The sync server trusts `x-commerce-user`, so a browser never reaches it
directly: the app serves the same URLs on its own origin through a **read
proxy** (`src/routes/jsonapi/[...path]/+server.ts`) that forwards a `GET`
with the header set from the Better Auth session — the trust boundary the
loads already cross. The universal catalog load calls it in-process on the
server and through the service worker in the browser, where the façade
answers covered URLs from the replica before the proxy is ever reached.

**Collation.** ADR-0028 orders and filters text by code point. SQLite's
default `BINARY` collation already is (`server/db.ts` says so beside the
DDL); a Postgres deployment declares its filterable and sortable text
columns `COLLATE "C"`.

## Running it

```bash
bun install && bun run build          # workspace root: build the packages
cd examples/commerce
bun run dev:server                    # the sync server (WS + HTTP + JSON:API, port 3100)
bun run dev                           # the SvelteKit app (port 5178, proxies /sync*)
```

Sign in with any username (demo auth — the point is the `IdentityResolver`
seam, not the credential ceremony). Try: two browsers with different users;
DevTools offline while adding to cart, then reconnect; killing the sync
server (calls degrade WS→HTTP first, then queue); a no-JS browser; DevTools
offline, then a plain `fetch("/jsonapi/products?page[limit]=4&sort=id", { headers: { accept: "application/vnd.api+json" } })`
in the console — the response carries `x-legation-served-at`.

A production build (`bun run build`, adapter-node) needs `BETTER_AUTH_SECRET`
set, and serves the read proxy itself; put a reverse proxy in front that
routes `/sync*` to the sync server, as the dev server and the browser test's
harness do.

## Tests

`bun run test` (from this directory) runs the app's server-side suites in
the workspace runner:

- `backend-contract.test.ts` — the ADR-0009 contract verification of the
  SQLite executor, whose rule 6 carries the differential harness's generated
  corpus (#153): every operator in the core over NULL, absent and astral
  values, so the SQLite compiler is proven exact against `Subset.apply`.
- `auth-split.test.ts` — the public/private auth split over the sync tier
  (anonymous catalog sync, empty private allow-sets, forged-identity
  rejection, the `order/place` round trip with stock decrement and cart
  clear).
- `derived-rest.test.ts` — the derived JSON:API end to end: every read the
  app makes at its canonical URL against a committed fixture
  (`tests/fixtures/rest/`, regenerate with `COMMERCE_FIXTURES=write`), the
  resources bridged through `NodeBridge` equal to the hand-written node
  graph, and the tier's promises (policy scoping, 400 with
  `source.parameter`, `fields[]`, cursor paging).
- `no-js-loads.test.ts` — the no-JS baseline: the real SvelteKit `load`
  functions (the server loads and the universal catalog load, as the server
  runs it for the first render) run against the in-process api, page by
  page, plus the read proxy's identity rule. Rendering the markup itself
  needs the Kit runtime and stays a manual check.
- `replica-documents.test.ts` — same URL, same result (ADR-0029 §6): every
  declared read's document from a synced replica equals the derived REST
  handler's byte for byte, and the façade over that replica answers covered
  URLs with those bytes.
- `facade-browser.test.ts` — the façade end to end in a browser (#168):
  the harness (`tests/support/app.ts`) builds the app (`vite build`, about
  fifteen seconds) and serves it in-process with its service worker active,
  in front of the sync server on ephemeral ports; Playwright drives the
  pre-installed Chromium and issues plain `fetch()`es from the page. It
  asserts, in order: online, an uncovered URL is the network's and a
  covered one is served from the replica once pulled, byte for byte the
  network's document; offline (`context.setOffline(true)` — Playwright's
  CDP network emulation over the page and the worker, the DevTools
  toggle's equivalent), the covered URL is still served, header present;
  offline, the uncovered URL is the 503 `offline` error document, both when
  the browser reads offline and when it reads online but the harness drops
  the worker's forward at the socket (the emulation leaves the worker's own
  fetches reachable); offline, "Add to cart" journals a mutation the
  covered cart URL shows before the server has the row, and the server
  catches up on reconnect. It needs Chromium: `bunx playwright-core install
  chromium` (or `PLAYWRIGHT_BROWSERS_PATH` pointing at an install); without
  it the suite fails naming the missing binary — it never skips. About
  forty seconds wall time, most of it the build and the engine's first pull.

## Deliberate next steps

- Host the engine in the service worker with tab mirrors over `ClientView`
  (ADR-0010/0021) — the binding-level proof already exists in
  `@legation/svelte`'s mirror test.
- Convert the remaining page loads to universal loads over the read proxy,
  so client navigation to the product, cart and orders pages also reads
  through the façade (the catalog is the one that does today).
- Swap the demo sign-in for Better Auth behind the same `client_groups` +
  `IdentityResolver` seam.
- An SSR-stub runtime helper for `@legation/svelte/kit` (see `lib/engine.ts`).
