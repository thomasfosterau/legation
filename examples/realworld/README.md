# legation · SvelteKit · RealWorld (Conduit)

The [RealWorld](https://codebase.show/projects/realworld) spec — Conduit —
driving [`@legation/effect`](../../packages/effect) through the
[`@legation/svelte`](../../packages/svelte) **rune hooks** on SvelteKit. Like the
other client-only examples it runs the **real library server pipeline in the
page** (`SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`) over a
durable `localStorage` client store.

The whole world — engine, durable store, demo backend — is browser-only, so the
app is a SvelteKit **SPA**: `ssr = false` in the root layout and
`adapter-static` with a fallback page.

## What it shows

- **A route per Conduit screen.** SvelteKit's file-based router owns navigation:
  `/`, `/login`, `/register`, `/settings`, `/editor` and `/editor/[[slug]]`
  (one optional param for "new" vs "edit"), `/article/[slug]`, and
  `/profile/[username]/[[tab=favorites]]` (a matched optional segment, so
  `/profile/emma/anything-else` 404s rather than quietly rendering the profile).
  `src/lib/routes.ts` is the one place that builds paths, so percent-encoding a
  slug or username happens once.
- **Five nodes, and the joins live in the reads.** The graph declares each
  foreign key once and names the inverse, so an article card's author and
  favourite count come from `allArticles`' `include: { author, favorites }`, a
  profile's follow state from `userProfile`'s `include: { followers }`, and a
  comment's author from `articleComments`' `include: { author }`.
  `src/lib/joins.ts` no longer joins — it shapes what the read resolved.
- **Reactive reads.** The article and comment reads are thunks over the route's
  `slug`, so navigating between articles re-subscribes while the previous rows
  stay on screen (stale-while-revalidate).
- **Optimistic mutations** — `src/lib/actions.svelte.ts` wraps `useMutation()`:
  every write (publish, favourite, follow, comment) lands in the overlay before
  any round trip, is journaled, and is replayed on rebase.
- **Server-side write authorization** — "logging in" tells the *server* who this
  client is (`world.setIdentity`, backed by an `IdentityResolver` over a `Ref`),
  so the backend's ownership checks, which read `context.identity`, accept only
  that user's writes. Read auth is public.
- **Zero-wiring client** — `Client.make` resolves its store and transport from
  context (supplied here as layers) and starts the sync loop itself, so the
  class of bug where an app forgets `runSync` cannot happen.
- **True offline** — the banner's toggle makes the transport *fail* push/pull,
  so writes pile up in the durable journal and flush on reconnect.

## Layout

```
src/lib/          domain (nodes/edges/reads), sync world, view shaping,
                  actions, session, paths
src/params/       route-param matchers (favorites)
src/routes/       +layout.ts (builds the world once) + one folder per screen
```

- `src/lib/domain.ts` — the five nodes and their edges, the mutation contracts
  with their optimistic handlers, and the reads each screen uses. A node's
  identity field is always `id`, so Conduit's natural keys ride along as
  attributes: `users.id === users.username`, `articles.id === articles.slug`.
- `src/lib/sync.ts` — `createWorld()`: the app `Layer` and the `ManagedRuntime`
  over it, exposing the `Client` runtime plus the demo side-channel (offline
  toggle, identity).
- `src/lib/session.svelte.ts` — the session as a rune: `username` is `$state`,
  and an `$effect` keeps the server identity and `localStorage` in lock-step.
- `src/routes/+layout.ts` — the root `load`: builds the world **once** for the
  lifetime of the app, and turns SSR off.
- `src/routes/+layout.svelte` — header, sync banner, footer; wires the Client
  runtime and the session into context for every route.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/realworld
bun run dev      # open the printed http://localhost:5177
```

Sign in as `emma / demo` or `liang / demo`, or register a new user.

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state. The _client_ is durable: pending offline writes survive
  reloads and flush on the next connect.
- The example is a workspace member for dependency consistency. It is excluded
  from the root `tsc` project, oxlint, and prettier (it is illustrative, not a
  published package), but CI does run its `check` script via
  `bun run typecheck:examples`.
