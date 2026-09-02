<script lang="ts">
  /**
   * The todo list.
   *
   * Todos come from `useQuery(() => allTodos)` — a live read whose `current` is
   * an `AsyncResult` that re-renders on every mutation, push ack, and
   * pull/rebase. Writes go through the undo manager, which replays them through
   * the same optimistic `mutate` pipeline. The demo knobs (offline, remote
   * edit, journal) come from the demo context the root layout wired up.
   *
   * The three filters are three URLs served by one optional route param, so
   * `data.filter` — not component state — decides what is on screen.
   */
  import { Effect } from "effect";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useAggregate, useQuery, useUndo } from "@legation/svelte";
  import { Aggregate } from "@legation/effect";
  import { type Todo, allTodos, activeTodos } from "$lib/domain";
  import { connectionState, getDemo, pendingState } from "$lib/demo.svelte";

  const { data } = $props();

  // `demo` comes from the context the layout set; `undo` rides down as layout
  // data (the manager is built once, alongside the engine).
  const demo = getDemo();
  // Built once with the engine and never reassigned (see `+layout.ts`).
  // svelte-ignore state_referenced_locally
  const manager = data.world.undo;

  const rows = useQuery(() => allTodos);
  // The "active" tally is a live Count aggregate over the incomplete-todos
  // read — derived by the engine, deduped so an edit that leaves the count
  // unchanged doesn't re-render the footer.
  const activeCount = useAggregate(() => activeTodos, Aggregate.count);
  // Undo/redo over the engine: `run` a paired intent (do + reverse), and the
  // rune tracks whether an undo/redo is currently possible.
  const history = useUndo(manager);
  const connection = connectionState(demo);
  const pending = pendingState(demo);

  const TABS = [
    { label: "All", href: "/" },
    { label: "Active", href: "/active" },
    { label: "Completed", href: "/completed" },
  ] as const;

  let draft = $state("");
  let remoteAgent = $state(false);
  let lastSyncAt = $state<number | null>(null);

  // `value` is `unknown` on a resolved row: the node graph types the schema,
  // but not what a read hands back, so the row value is cast at the edge.
  const todos = $derived(
    AsyncResult.getOrElse(rows.current, () => []).map((row) => row.value as Todo)
  );
  const offline = $derived(connection.current === "disconnected");
  const total = $derived(todos.length);
  const active = $derived(AsyncResult.getOrElse(activeCount.current, () => 0) ?? 0);
  const completed = $derived(total - active);
  const visible = $derived(
    data.filter === "All"
      ? todos
      : data.filter === "Active"
        ? todos.filter((todo) => !todo.done)
        : todos.filter((todo) => todo.done)
  );

  const connectionLabel = (status: string): string =>
    status === "connected" ? "online" : status === "disconnected" ? "offline" : "connecting…";

  // The simulated remote agent: writes to the backend on a timer while on.
  $effect(() => {
    if (!remoteAgent) return;
    const timer = setInterval(() => void demo.simulateRemote(), 4000);
    return () => clearInterval(timer);
  });

  // Every write is a *paired intent*: the mutation to run now plus the mutation
  // that reverses it. `manager.run` applies `execute` optimistically (journaled,
  // rebased, offline-safe) and records the pair so undo/redo can replay it.
  const run = (entry: Parameters<typeof manager.run>[0]): void => void Effect.runPromise(manager.run(entry));

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

  // Mutations re-run on every rebase, so toggling is a full idempotent put; its
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

  const syncNow = (): void => void demo.syncNow().then(() => (lastSyncAt = Date.now()));

  // Keyboard shortcuts: ⌘Z / ⌃Z to undo, add Shift to redo.
  const onKeydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) void history.redo();
    else void history.undo();
  };
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <div class="card">
    <h1 class="title">legation · SvelteKit</h1>
    <p class="subtitle">Offline-first todos: optimistic writes, live views, push/pull rebase.</p>

    <div class="status-bar">
      <span class="pill pill-{connection.current}">● {connectionLabel(connection.current)}</span>
      <span class={pending.current.length > 0 ? "pill pill-pending" : "pill pill-clean"}>
        {pending.current.length > 0 ? `${pending.current.length} pending` : "all synced"}
      </span>
      <span class="muted">
        {lastSyncAt === null ? "" : `last sync ${new Date(lastSyncAt).toLocaleTimeString()}`}
      </span>
    </div>

    <div class="controls">
      <button class={offline ? "btn btn-warn" : "btn"} onclick={() => void demo.setOnline(offline)}>
        {offline ? "Go online" : "Go offline"}
      </button>
      <button class="btn" onclick={syncNow}>Sync now</button>
      <button class="btn" onclick={() => void demo.simulateRemote()}>Remote edit</button>
      <button class={remoteAgent ? "btn btn-active" : "btn"} onclick={() => (remoteAgent = !remoteAgent)}>
        {remoteAgent ? "Remote agent: on" : "Remote agent: off"}
      </button>
      <button class="btn" disabled={!history.canUndo} onclick={() => void history.undo()} title="Undo (⌘Z / Ctrl+Z)">
        Undo
      </button>
      <button class="btn" disabled={!history.canRedo} onclick={() => void history.redo()} title="Redo (⇧⌘Z / Ctrl+Shift+Z)">
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

    <nav class="tabs">
      {#each TABS as tab (tab.href)}
        <a class={data.filter === tab.label ? "tab tab-active" : "tab"} href={tab.href}>
          {tab.label}
        </a>
      {/each}
    </nav>

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
        <button class="link" onclick={clearCompleted}>clear completed</button>
      {:else}
        <span class="muted">—</span>
      {/if}
    </div>

    {#if pending.current.length === 0}
      <div class="journal journal-empty">Journal empty — every write is confirmed.</div>
    {:else}
      <div class="journal">
        <div class="journal-title">Pending journal (optimistic, unconfirmed)</div>
        <ul class="journal-list">
          {#each pending.current as entry (entry.mutationId)}
            <li class="journal-row">#{entry.mutationId} {entry.summary}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>
