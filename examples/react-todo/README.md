# legation · React example

A browser todo app that drives
[`@legation/effect`](../../packages/core) from React through the
[`@legation/react`](../../packages/react) bindings
(`useQuery` / `useMutation`). It is the React counterpart to the
[Svelte](../svelte-todo) and [FoldKit](../foldkit-todo) examples, and like
FoldKit it runs the **real library server pipeline in the page**, so every
concept in `CONTEXT.md` is exercised by code you can click on.

## What it shows

- **Optimistic writes** — adding, toggling, or deleting a todo calls the
  `useMutation()` mutate function; the row updates immediately, before any round
  trip. The mutator handlers are idempotent because they re-run on every rebase.
- **Live views** — the list is `useQuery(allTodos)`: a forked `observe` fiber
  bridged to React via `useSyncExternalStore`, re-rendering on every local
  change (mutation, push ack, pull/rebase).
- **A durable journal + true offline** — the client store is the engine's
  `KeyValueStore`-backed `ClientStore` over `localStorage`. "Go offline" makes
  the transport **fail** push/pull, so writes pile up in the journal (the
  _Pending journal_ panel) and survive a reload. "Go online" lets the sync loop
  flush and pull on reconnect.
- **Push / pull / CVR patches / rebase** — the in-page server is the genuine
  `SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`. Pulls return
  CVR-diffed patches; the client rebases pending mutations on top.
- **Poke-driven live convergence** — "Remote edit" (and the optional _Remote
  agent_ timer) writes to the backend as a second client and publishes an
  invalidation hint. The sync server pokes this client's subscription, the
  engine pulls, and the change appears with no local action.

## Architecture

```
  <EffectSyncProvider runtime={…}>        runtime = ManagedRuntime providing the
        │  useQuery / useMutation          built ClientEngine
        ▼
  ClientEngine ──(offline-aware loopback transport)──▶ SyncServer
       │                                                   │
  durable ClientStore (localStorage)                  MemoryBackend
       │                                              + CvrStore (CVR diff)
  optimistic overlay + journal                        + InvalidationBus (poke)
```

- `src/domain.ts` — the `Todo` collection, the `todo/set` / `todo/remove`
  mutators, and the `allTodos` subset (shared client + server vocabulary).
- `src/sync.ts` — `createWorld()`: wires the whole stack, then exposes the
  engine `runtime` (for the React bindings) plus the demo `controls`.
- `src/demo.tsx` — a small React context for the demo knobs the engine's
  read/write API doesn't cover (offline, remote edit, the journal, connection).
- `src/App.tsx` — the UI, built entirely from `useQuery` / `useMutation` + the
  demo context.
- `src/main.tsx` — builds the world, then mounts React under both providers.

## Run

This example is a workspace member: it consumes the engine and its React
bindings via `workspace:*` (their built `dist`) and shares the root **Bun
catalog** for `effect` / `@effect/platform-browser`. Build the packages once,
then run the dev server:

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/react-todo
bun run dev      # open the printed http://localhost:5174
```

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed rows reappear). The _client_ is durable: pending
  offline writes in the journal survive reloads and flush on the next connect.
- The example is a workspace member for dependency consistency, but it stays
  outside the CI quality gates (build/typecheck/lint/format), like the other
  examples; it is illustrative, not a published package.
