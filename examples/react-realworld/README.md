# legation · React · RealWorld (Conduit)

The [RealWorld](https://github.com/gothinkster/realworld) spec app — a
Medium-style blogging platform ("Conduit") — driving
[`@legation/effect`](../../packages/effect) from React through the
[`@legation/react`](../../packages/react) bindings. Like the
todo examples it runs the **real library server pipeline in the page**
(`SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`) over a durable
`localStorage` client store, but it exercises the engine's _relational_ and
_authorization_ surfaces, not just a single collection.

It uses the official Conduit stylesheet, so it looks like every other RealWorld
implementation — the interesting part is what's behind it.

## What it shows

- **Several collections, joined over the mirror.** `users`, `articles`,
  `comments`, `favorites`, and `follows` are independent typed collections. The
  relational shapes Conduit renders — an article with its author and your
  favourite state, a profile with its follow state, the personal feed — are
  assembled in `data.ts` as reactive client-side joins (`useMemo` over live
  `useQuery` results). Favourite counts and follow flags are **derived from the
  join collections**, never denormalised onto the row, so a rebase can't leave a
  stale counter.
- **Everything is an optimistic mutator.** Posting, editing, commenting,
  favouriting, and following all call `useMutation()`; the overlay updates
  before any round trip and the same intent is replayed on rebase.
- **Server-side write authorization.** Read auth is allow-all (Conduit content
  is public), but every write runs an authoritative backend handler that checks
  `context.identity` against the row's owner — you can't edit someone else's
  article or delete their comment. "Logging in" sets the identity the server
  sees (`world.setIdentity`), wired through an `IdentityResolver`; the client
  can't forge it.
- **Offline-first.** The sync status banner toggles the transport offline:
  writes queue in the durable journal and flush on reconnect, surviving reloads.
- **Push / pull / CVR patches / rebase** across all five collections, with
  poke-driven live convergence from the in-page server.

## Layout

- `src/domain.ts` — collections, mutator contracts, and the subsets subscribed
  on boot (shared client + server vocabulary).
- `src/sync.ts` — `createWorld()`: the in-page pipeline, the backend handlers
  with ownership checks, the `IdentityResolver` over a mutable current-user, and
  seed data. Returns the engine `runtime` + demo controls.
- `src/data.ts` — the relational read layer (client-side joins as hooks).
- `src/auth.tsx` / `src/actions.ts` — the session and the write surface.
- `src/world.tsx` — context for the demo controls (identity, offline,
  connection).
- `src/router.tsx` — a tiny dependency-free hash router.
- `src/components.tsx`, `src/pages/*`, `src/App.tsx` — the Conduit UI.

## Run

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/react-realworld
bun run dev      # open the printed http://localhost:5176
```

Sign in with a seeded account (`emma` / `demo` or `liang` / `demo`), or register
a new one. The Conduit CSS is loaded from a CDN, so the styled look needs
network; the app logic itself is entirely in-page.

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed reappears). The _client_ journal is durable.
- The example is a workspace member for dependency consistency but stays outside
  the CI quality gates, like the other examples; it is illustrative, not a
  published package.
