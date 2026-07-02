# legation · Svelte example

A browser todo app that drives
[`@legation/effect`](../../packages/effect) from Svelte through the
[`@legation/svelte`](../../packages/svelte) bindings
(`query` stores + `undoControls`). It is the Svelte counterpart to the
[React](../react-todo) and [FoldKit](../foldkit-todo) examples, and like the
others it runs the **real library server pipeline in the page**, so every
concept in `CONTEXT.md` is exercised by code you can click on.

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
- **Live views** — the list is `query(allTodos)`, a Svelte `Readable` store
  backed by a forked `observe` fiber. Read with `$todos` auto-subscription, it
  re-renders on every local change (mutation, push ack, pull/rebase).
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
  setEngineRuntime(runtime)               runtime = ManagedRuntime providing the
        │  query / getMutate               built ClientEngine
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
  engine `runtime` (for the Svelte bindings) plus the demo `controls`.
- `src/demo.ts` — a small Svelte context + two stores for the demo knobs the
  engine's read/write API doesn't cover (offline, remote edit, journal,
  connection).
- `src/App.svelte` — the UI: `setEngineRuntime` + `query` + `undoControls` and
  the demo context, in idiomatic Svelte 5 runes.
- `src/main.ts` — builds the world, then mounts the app with the runtime +
  controls + undo manager as props.

## Recipe: paired-intents undo

The `Undo` module (`@legation/effect`) adds undo/redo without touching the
engine: the caller supplies both directions of a change, and undo/redo replay
through `ClientEngine.mutate`, so they inherit the overlay, the journal, rebase,
and offline behaviour for free.

```ts
import { Undo } from "@legation/effect";
import { undoControls } from "@legation/svelte";

// One manager per client (in-memory history) — see src/sync.ts.
const manager = yield * Undo.make(engine);

// Svelte stores + handlers — see src/App.svelte.
const { canUndo, canRedo, undo, redo } = undoControls(manager);

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
bindings via `workspace:*` (their built `dist`) and shares the root **Bun
catalog** for `effect` / `@effect/platform-browser`. Build the packages once,
then run the dev server:

```sh
# from the repo root
bun install
bun run build

# then, in this example
cd examples/svelte-todo
bun run dev      # open the printed http://localhost:5175
```

## Notes

- **The server is ephemeral.** `MemoryBackend` lives in the page, so a reload
  resets server state (the seed rows reappear). The _client_ is durable: pending
  offline writes in the journal survive reloads and flush on the next connect.
- The example is a workspace member for dependency consistency, but it stays
  outside the CI quality gates (build/typecheck/lint/format), like the other
  examples; it is illustrative, not a published package.
