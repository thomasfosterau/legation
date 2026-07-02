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
  import { query, aggregate, getMutate, setEngineRuntime } from "@legation/svelte";
  import { Aggregate } from "@legation/effect";
  import { type Todo, allTodos, activeTodos } from "./domain";
  import type { DemoControls } from "./sync";
  import type { EffectSyncRuntime } from "@legation/svelte";
  import { setDemo, connectionStore, pendingStore } from "./demo";

  type Filter = "All" | "Active" | "Completed";

  let { runtime, controls }: { runtime: EffectSyncRuntime; controls: DemoControls } = $props();

  // Wire the engine runtime + demo controls into context for this subtree.
  setEngineRuntime(runtime);
  setDemo(controls);

  const rows = query(allTodos);
  // The "active" tally is a live Count aggregate over the incomplete-todos
  // subset — derived by the engine, deduped so an edit that leaves the count
  // unchanged doesn't re-render the footer.
  const activeCount = aggregate(activeTodos, Aggregate.count);
  const mutate = getMutate();
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

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const title = draft.trim();
    if (title.length === 0) return;
    draft = "";
    void mutate("todo/set", { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() });
  };

  // Mutators re-run on every rebase, so toggling is a full idempotent put.
  const toggle = (todo: Todo): void => void mutate("todo/set", { ...todo, done: !todo.done });
  const remove = (id: string): void => void mutate("todo/remove", { id });
  const syncNow = (): void => void controls.syncNow().then(() => (lastSyncAt = Date.now()));
</script>

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
            <button class="link link-danger" onclick={() => remove(todo.id)}>delete</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="footer">
      <span>{active} active · {completed} completed · {total} total</span>
      {#if completed > 0}
        <button
          class="link"
          onclick={() => todos.filter((todo) => todo.done).forEach((todo) => remove(todo.id))}
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
