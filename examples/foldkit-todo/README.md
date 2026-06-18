# effect-sync · FoldKit example

A deliberately over-engineered browser todo app that drives
[`@thomasfosterau/effect-sync-core`](../../packages/core) from
[FoldKit](https://foldkit.dev) — The Elm Architecture in TypeScript, built (like
this engine) on Effect. It is the web counterpart to the
[Compose](../compose-todo) and [SwiftUI](../swiftui-todo) examples, but instead
of a hand-rolled demo server it runs the **real library server pipeline in the
page**, so every concept in `CONTEXT.md` is exercised by code you can click on.

## What it shows

- **Optimistic writes** — adding, toggling, or deleting a todo calls
  `engine.mutate(...)`; the row updates immediately, before any round trip. The
  mutator handlers are idempotent because they re-run on every rebase.
- **Live views** — the list is `engine.observe(allTodos)` bridged into a FoldKit
  `Subscription`; it re-emits on every local change (mutation, push ack,
  pull/rebase) and the model updates through `update`.
- **A durable journal + true offline** — the client store is the engine's
  `KeyValueStore`-backed `ClientStore` over `localStorage`. "Go offline" makes
  the transport **fail** push/pull, so writes pile up in the journal (visible in
  the _Pending journal_ panel) and survive a reload. "Go online" lets the
  engine's sync loop flush and pull automatically on reconnect.
- **Push / pull / CVR patches / rebase** — the in-page server is the genuine
  `SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`. Pulls return
  CVR-diffed patches; the client rebases pending mutations on top.
- **Poke-driven live convergence** — "Remote edit" (and the optional _Remote
  agent_ timer) writes to the backend as a second client and publishes an
  invalidation hint. The sync server pokes this client's subscription, the
  engine pulls, and the change appears with no local action.

## Architecture

```
  ClientEngine ──(offline-aware loopback transport)──▶ SyncServer
       │                                                   │
  durable ClientStore (localStorage)                  MemoryBackend
       │                                              + CvrStore (CVR diff)
  optimistic overlay + journal                        + InvalidationBus (poke)
```

- `src/domain.ts` — the `Todo` collection, the `todo/set` / `todo/remove`
  mutators, and the `allTodos` subset (shared client + server vocabulary).
- `src/sync.ts` — `createSyncWorld()`: wires the whole stack and exposes a small
  `SyncWorld` handle (live streams + promise-returning actions).
- `src/main.ts` — the FoldKit `Model` / `Message` / `update` / `view` /
  `subscriptions`. Engine effects are issued as `Command`s; live data arrives as
  subscription streams.
- `src/entry.ts` — builds the world, then starts the FoldKit runtime.

## Run

This example is a workspace member: it consumes the engine via `workspace:*`
(its built `dist`) and shares the root **Bun catalog** for `effect` /
`@effect/platform-browser`, so there is a single `effect` version across the
monorepo and the demo. Build the packages once, then run the dev server:

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/foldkit-todo
bun run dev      # open the printed http://localhost:5173
```

## Notes

- **Versions come from the catalog.** `effect` and `@effect/platform-browser`
  are pinned once in the root `package.json` `workspaces.catalog` (currently
  `4.0.0-beta.83`, which is also FoldKit's pin), referenced here as `catalog:`.
  Bumping the catalog moves the whole monorepo and this demo together.
- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed rows reappear). The _client_ is durable: pending
  offline writes in the journal survive reloads and flush on the next connect.
- The example is a workspace member for dependency consistency, but it stays
  outside the CI quality gates (build/typecheck/lint/format), like the
  Compose/SwiftUI examples; it is illustrative, not a published package.
