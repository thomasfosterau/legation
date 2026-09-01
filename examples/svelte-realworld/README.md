# legation · SvelteKit · RealWorld (Conduit)

The [RealWorld](https://codebase.show/projects/realworld) spec — Conduit —
driving [`@legation/effect`](../../packages/effect) through the
[`@legation/svelte`](../../packages/svelte) bindings on SvelteKit. Like the
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
- **Five collections joined over the mirror** — `src/lib/data.ts` builds one
  live store per collection; `src/lib/joins.ts` combines them into the feed,
  article, and profile views with pure functions re-run by `$derived`. Comments
  join their author through the binding's `related` store, maintained
  incrementally by the engine rather than a hand-rolled lookup.
- **Optimistic mutators** — `src/lib/actions.ts` wraps `getMutate()`: every
  write (publish, favourite, follow, comment) lands in the overlay before any
  round trip, is journaled, and is replayed on rebase.
- **Server-side write authorization** — "logging in" tells the *server* who this
  client is (`world.setIdentity`), so the backend's ownership checks, which read
  `context.identity`, accept only that user's writes. Read auth is public.
- **True offline** — the banner's toggle makes the transport *fail* push/pull,
  so writes pile up in the durable journal and flush on reconnect.

## Layout

```
src/lib/          domain, sync world, data stores, joins, actions, auth, paths
src/params/       route-param matchers (favorites)
src/routes/       +layout.ts (builds the world once) + one folder per screen
```

- `src/lib/domain.ts` — collections, mutator contracts, and subsets: the shared
  client + server vocabulary.
- `src/lib/sync.ts` — `createWorld()`: wires the whole stack, then exposes the
  engine `runtime` plus the demo side-channel (offline toggle, identity).
- `src/routes/+layout.ts` — the root `load`: builds the world **once** for the
  lifetime of the app, and turns SSR off.
- `src/routes/+layout.svelte` — header, sync banner, footer; wires the runtime,
  data stores, and session into context for every route.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/svelte-realworld
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
