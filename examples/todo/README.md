# legation · SvelteKit todo

A SvelteKit todo app that drives [`@thomasfosterau/legation-effect`](../../packages/effect)
through the [`@thomasfosterau/legation-svelte`](../../packages/svelte) **rune hooks**
(`useQuery` / `useAggregate`). It runs the **real library server pipeline in the
page**, so every concept in `CONTEXT.md` is exercised by code you can click on.

The whole world — engine, durable store, demo backend — is browser-only, so the
app is a SvelteKit **SPA**: `ssr = false` in the root layout and
`adapter-static` with a fallback page, which any static host can serve.

## What it shows

- **Optimistic writes** — adding, toggling, or deleting a todo runs a mutation;
  the row updates immediately, before any round trip. The mutator handlers are
  idempotent because they re-run on every rebase.
- **Undo / redo (#46)** — every write goes through the `Undo` manager as a
  _paired intent_ (the mutation to run plus the mutation that reverses it). Undo
  and redo replay through the same optimistic `mutate` pipeline, so they are
  journaled, rebased, and offline-safe like any write. Press **⌘Z / Ctrl+Z** to
  undo and **⇧⌘Z / Ctrl+Shift+Z** to redo, or use the toolbar buttons; the
  history is in-memory and per-client (a reload clears it).
- **The filter is a route** — `/`, `/active`, and `/completed` are one
  optional route param (`[[filter=filter]]`, matched by `src/params.ts`)
  loaded into `data.filter`, not component state: the tabs are links, the back
  button works, and a filtered list is shareable.
- **Live views** — the list is `useQuery(() => allTodos)`, whose reactive
  `current` is an `AsyncResult` over a declarative `Query.Read`. It re-renders
  on every local change (mutation, push ack, pull/rebase), and the "active"
  tally is a live `useAggregate(… , Aggregate.count)` the engine maintains
  rather than an app-side `.filter().length`.
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
  +layout.svelte: setClientRuntime(runtime)   runtime = ManagedRuntime whose
        │  useQuery / useAggregate            layer provides the Client
        ▼
  Client ──(loopback transport + simulated-offline gate)──▶ Server
     │                                                        │
  durable ClientStore (localStorage)                    MemoryBackend
     │                                                  + CVR diffing
  optimistic overlay + journal                          + hint fan-out
```

The whole stack is one `Layer`, run by a `ManagedRuntime` — the runtime owns
the scope, so the forked sync loop and the server's fan-out live exactly as
long as the app does.

- `src/lib/domain.ts` — the `todos` node, the `todo/set` / `todo/remove`
  mutations with their optimistic handlers, and the `allTodos` / `activeTodos`
  reads (shared client + server vocabulary).
- `src/lib/sync.ts` — `createWorld()`: the app `Layer` and the `ManagedRuntime`
  over it, exposing the `Client` runtime (for the rune hooks) plus the demo
  `Demo` controls.
- `src/lib/demo.svelte.ts` — a small Svelte context plus two runes for the demo
  knobs the Client's read/write API doesn't cover (offline, remote edit,
  journal, connection).
- `src/routes/+layout.ts` — the root `load`: builds the world **once** for the
  lifetime of the app, and turns SSR off (the engine is browser-only).
- `src/routes/+layout.svelte` — wires the engine runtime and the demo controls
  into context for the whole route tree.
- `src/params.ts` + `src/routes/[[filter=filter]]/` — the filter is the
  URL: one optional, matched route param serves `/`, `/active`, and
  `/completed`, so the tabs are plain links and a filtered list is shareable.
- `src/routes/[[filter=filter]]/+page.svelte` — the UI: `useQuery`,
  `useAggregate` and `undoControls` in idiomatic Svelte 5 runes.

## Recipe: paired-intents undo

The `Undo` module (`@thomasfosterau/legation-effect/internal`) adds undo/redo without touching the
engine: the caller supplies both directions of a change, and undo/redo replay
through the supplied handle's `mutate` — a `Client` (as here) or a
`ClientEngine` both work (#223) — so they inherit the overlay, the journal,
rebase, and offline behaviour for free.

```ts
import { Undo } from "@thomasfosterau/legation-effect/internal";
import { useUndo } from "@thomasfosterau/legation-svelte";

// One manager per client (in-memory history) — see src/lib/sync.ts.
const manager = yield * Undo.make(client);

// Rune-backed controls — see the route's +page.svelte. Read
// `history.canUndo` / `history.canRedo` in place; destructuring them would
// capture one value instead of tracking it.
const history = useUndo(manager);

// A create: undo is a delete of the same id.
manager.run({
  execute: { mutator: "todo/set", args: todo },
  undo: { mutator: "todo/remove", args: { id: todo.id } },
});
```

**Delete-then-undo** is the case that needs care: to bring a deleted row back,
capture its value from the local view *at run time* and pass it as the undo's
`set` args, so the undo re-creates the row exactly.

```ts
// `todo` is the current row, read from `query(allTodos)` before deleting.
manager.run({
  execute: { mutator: "todo/remove", args: { id: todo.id } },
  undo: { mutator: "todo/set", args: todo }, // captured pre-delete value
});
```

**Grouping** coalesces several `run`s into one undo step — "clear completed"
deletes every done todo inside `manager.group(...)`, so a single undo restores
them all.

## Run

This example is a workspace member: it consumes the engine and its Svelte
bindings via `workspace:*` (their built `dist`) and shares the root **pnpm
catalog** for `effect` / `@effect/platform-browser`. Build the packages once,
then run the dev server:

```sh
# from the repo root
pnpm install
vp run build

# then, in this example
cd examples/todo
pnpm run dev      # open the printed http://localhost:5175
```

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed rows reappear). The _client_ is durable: pending
  offline writes in the journal survive reloads and flush on the next connect.
- The example is a workspace member for dependency consistency. It is excluded
  from the root `tsc` project, oxlint, and prettier (it is illustrative, not a
  published package), but CI does run its `check` script via
  `vp run check:examples`, so binding-API changes in `packages/*` can't
  silently rot it.
