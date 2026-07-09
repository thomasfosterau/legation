<script lang="ts">
  /**
   * App
   *
   * The whole UI. Todos come from `query(allTodos)` (a live Svelte store:
   * re-renders on every mutation, push ack, and pull/rebase); writes go through
   * `getMutate()` optimistically. The demo knobs (offline, remote edit,
   * journal) come from the demo context. Visual design and behaviour mirror the
   * FoldKit / React / Compose / SwiftUI todo examples.
   */
  import { Effect } from "effect";
  import { Query, Runtime, Undo as UndoBindings } from "@legation/svelte";
  import { Aggregate } from "@legation/effect";
  import { type Undo } from "@legation/effect/internal";
  import { type Todo, allTodos, activeTodos } from "./domain";
  import type { DemoControls } from "./sync";
  import { setDemo, connectionStore, pendingStore } from "./demo";

  type Filter = "All" | "Active" | "Completed";

  let {
    runtime,
    controls,
    undo: manager,
  }: {
    runtime: Runtime.EffectSyncRuntime;
    controls: DemoControls;
    undo: Undo.UndoManager;
  } = $props();

  // Wire the engine runtime + demo controls into context for this subtree.
  Runtime.setEngineRuntime(runtime);
  setDemo(controls);

  const rows = Query.query(allTodos);
  // The "active" tally is a live Count aggregate over the incomplete-todos
  // subset — derived by the engine, deduped so an edit that leaves the count
  // unchanged doesn't re-render the footer.
  const activeCount = Query.aggregate(activeTodos, Aggregate.count);
  // Undo/redo over the engine: `run` a paired intent (do + reverse), and the
  // stores track whether an undo/redo is currently possible.
  const { canUndo, canRedo, undo, redo } = UndoBindings.undoControls(manager);
  const connection = connectionStore(controls);
  const pending = pendingStore(controls);

  let draft = $state("");
  let filter = $state<Filter>("All");
  let remoteAgent = $state(false);
  let lastSyncAt = $state<number | null>(null);

  const todos = $derived($rows.map((row) => row.value as Todo));
  const offline = $derived($connection === "disconnected");
  const total = $derived(todos.length);
  const active = $derived($activeCount ?? 0);
  const completed = $derived(total - active);
  const visible = $derived(
    filter === "All"
      ? todos
      : filter === "Active"
        ? todos.filter((todo) => !todo.done)
        : todos.filter((todo) => todo.done)
  );

  const connectionLabel = (status: string): string =>
    status === "connected" ? "online" : status === "disconnected" ? "offline" : "connecting…";

  // The simulated remote agent: writes to the backend on a timer while on.
  $effect(() => {
    if (!remoteAgent) return;
    const timer = setInterval(() => void controls.simulateRemote(), 4000);
    return () => clearInterval(timer);
  });

  // Every write is a *paired intent*: the mutation to run now plus the mutation
  // that reverses it. `manager.run` applies `execute` optimistically (journaled,
  // rebased, offline-safe) and records the pair so undo/redo can replay it.
  const run = (entry: Undo.UndoEntry): void => void manager.run(entry);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const title = draft.trim();
    if (title.length === 0) return;
    draft = "";
    const todo: Todo = { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() };
    // Undo of a create is a delete of the same id.
    run({
      execute: { mutator: "todo/set", args: todo },
      undo: { mutator: "todo/remove", args: { id: todo.id } },
    });
  };

  // Mutators re-run on every rebase, so toggling is a full idempotent put; its
  // undo restores the pre-toggle row captured here.
  const toggle = (todo: Todo): void =>
    run({
      execute: { mutator: "todo/set", args: { ...todo, done: !todo.done } },
      undo: { mutator: "todo/set", args: todo },
    });

  // Delete-then-undo: capture the whole pre-delete row now, so its undo
  // re-creates it exactly (the paired-intents way to satisfy #46's criterion).
  const remove = (todo: Todo): void =>
    run({
      execute: { mutator: "todo/remove", args: { id: todo.id } },
      undo: { mutator: "todo/set", args: todo },
    });

  // Clear-completed is many deletes coalesced into ONE undo step via `group`,
  // so a single undo brings every cleared todo back.
  const clearCompleted = (): void => {
    const done = todos.filter((todo) => todo.done);
    void Effect.runPromise(
      manager.group(
        Effect.forEach(done, (todo) =>
          manager.run({
            execute: { mutator: "todo/remove", args: { id: todo.id } },
            undo: { mutator: "todo/set", args: todo },
          })
        )
      )
    );
  };

  const syncNow = (): void => void controls.syncNow().then(() => (lastSyncAt = Date.now()));

  // Keyboard shortcuts: ⌘Z / ⌃Z to undo, add Shift to redo.
  const onKeydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) void redo();
    else void undo();
  };
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <div class="card">
    <h1 class="title">legation · Svelte</h1>
    <p class="subtitle">Offline-first todos: optimistic writes, live views, push/pull rebase.</p>

    <div class="status-bar">
      <span class="pill pill-{$connection}">● {connectionLabel($connection)}</span>
      <span class={$pending.length > 0 ? "pill pill-pending" : "pill pill-clean"}>
        {$pending.length > 0 ? `${$pending.length} pending` : "all synced"}
      </span>
      <span class="muted">
        {lastSyncAt === null ? "" : `last sync ${new Date(lastSyncAt).toLocaleTimeString()}`}
      </span>
    </div>

    <div class="controls">
      <button class={offline ? "btn btn-warn" : "btn"} onclick={() => void controls.setOnline(offline)}>
        {offline ? "Go online" : "Go offline"}
      </button>
      <button class="btn" onclick={syncNow}>Sync now</button>
      <button class="btn" onclick={() => void controls.simulateRemote()}>Remote edit</button>
      <button class={remoteAgent ? "btn btn-active" : "btn"} onclick={() => (remoteAgent = !remoteAgent)}>
        {remoteAgent ? "Remote agent: on" : "Remote agent: off"}
      </button>
      <button class="btn" disabled={!$canUndo} onclick={() => void undo()} title="Undo (⌘Z / Ctrl+Z)">
        Undo
      </button>
      <button class="btn" disabled={!$canRedo} onclick={() => void redo()} title="Redo (⇧⌘Z / Ctrl+Shift+Z)">
        Redo
      </button>
    </div>

    <form class="add-form" onsubmit={submit}>
      <input
        class="add-input"
        bind:value={draft}
        placeholder={offline ? "Offline — writes will queue" : "What needs doing?"}
      />
      <button class="btn btn-primary" type="submit">Add</button>
    </form>

    <div class="tabs">
      {#each ["All", "Active", "Completed"] as const as tab}
        <button class={filter === tab ? "tab tab-active" : "tab"} onclick={() => (filter = tab)}>
          {tab}
        </button>
      {/each}
    </div>

    {#if visible.length === 0}
      <div class="empty">Nothing here yet.</div>
    {:else}
      <ul class="todo-list">
        {#each visible as todo (todo.id)}
          <li class={todo.done ? "todo todo-done" : "todo"}>
            <label class="todo-main">
              <input type="checkbox" checked={todo.done} onchange={() => toggle(todo)} />
              <span class="todo-title">{todo.title}</span>
            </label>
            <button class="link link-danger" onclick={() => remove(todo)}>delete</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="footer">
      <span>{active} active · {completed} completed · {total} total</span>
      {#if completed > 0}
        <button
          class="link"
          onclick={clearCompleted}
        >
          clear completed
        </button>
      {:else}
        <span class="muted">—</span>
      {/if}
    </div>

    {#if $pending.length === 0}
      <div class="journal journal-empty">Journal empty — every write is confirmed.</div>
    {:else}
      <div class="journal">
        <div class="journal-title">Pending journal (optimistic, unconfirmed)</div>
        <ul class="journal-list">
          {#each $pending as entry (entry.mutationId)}
            <li class="journal-row">#{entry.mutationId} {entry.summary}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>
