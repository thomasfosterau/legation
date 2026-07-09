<script lang="ts">
  /**
   * @legation/devtools/svelte — DevtoolsPanel
   *
   * A thin Svelte panel over the headless `DevtoolsCore` (#120): every
   * section below just reads a store built by `store.ts` (which in turn
   * just runs the core's Effects/Streams) — no data acquisition of its own.
   * Visual polish is out of scope for this first cut: plain, legible markup.
   */
  import { untrack } from "svelte";
  import { Effect, Fiber, HashMap } from "effect";
  import type { DevtoolsCore } from "../src/Devtools.js";
  import { makeStores } from "./store.js";

  const props: { core: DevtoolsCore } = $props();
  // `core` is a stable singleton built once by the app's `createWorld`, the
  // same as `App.svelte`'s own `world` prop; read it untracked so the
  // one-time store wiring below isn't flagged as reading reactive state.
  const core = untrack(() => props.core);

  const { mutationStates, subscriptions, cookie, collections, events, syncFailures } =
    makeStores(core);

  const journalEntries = $derived(
    [...HashMap.values($mutationStates)].toSorted((a, b) => b.mutationId - a.mutationId)
  );
  const pendingCount = $derived(journalEntries.filter((e) => e.phase === "pending").length);

  const summarise = (mutator: string, args: unknown): string => {
    try {
      return `${mutator} ${JSON.stringify(args)}`;
    } catch {
      return mutator;
    }
  };

  let offline = $state<boolean | undefined>(undefined);

  $effect(() => {
    if (core.offline === undefined) return;
    const fiber = Effect.runFork(
      Effect.map(core.offline.isOffline, (value) => {
        offline = value;
      })
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

  const toggleOffline = (): void => {
    if (core.offline === undefined) return;
    const next = !(offline ?? false);
    void Effect.runPromise(core.offline.setOffline(next)).then(() => {
      offline = next;
    });
  };

  const forcePull = (): void => void Effect.runPromise(core.forcePull);
  const forcePush = (): void => void Effect.runPromise(core.forcePush);
  const dropSubscription = (subset: (typeof $subscriptions)[number]): void =>
    void Effect.runPromise(core.dropSubscription(subset));
  const clearStore = (): void => {
    if (!confirm("Clear every confirmed row from the store? This cannot be undone.")) return;
    void Effect.runPromise(core.clearStore);
  };
</script>

<div>
  <h2>Devtools</h2>

  <section>
    <h3>Journal &amp; mutations</h3>
    <p>{pendingCount} pending, {journalEntries.length} total (newest first)</p>
    {#if journalEntries.length === 0}
      <p>Journal empty.</p>
    {:else}
      <ul>
        {#each journalEntries as entry (entry.mutationId)}
          <li>
            <strong>{entry.phase}</strong> #{entry.mutationId}
            {summarise(entry.mutator, entry.args)}
            {#if entry.phase === "rejected" && entry.reason !== undefined}
              — {entry.reason}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>Subscriptions &amp; collections</h3>
    <p>Cookie: {$cookie ?? "(none — no pull yet)"}</p>
    <h4>Active subscriptions</h4>
    {#if $subscriptions.length === 0}
      <p>None.</p>
    {:else}
      <ul>
        {#each $subscriptions as s, i (i)}
          <li>
            {s.collection} — where {JSON.stringify(s.where)}
            {#if s.orderBy.length > 0}, order {JSON.stringify(s.orderBy)}{/if}
            {#if s.limit !== undefined}, limit {s.limit}{/if}
          </li>
        {/each}
      </ul>
    {/if}
    <h4>Collections</h4>
    {#if $collections.length === 0}
      <p>None synced yet.</p>
    {:else}
      <ul>
        {#each $collections as c (c.name)}
          <li>{c.name}: {c.rowCount} row{c.rowCount === 1 ? "" : "s"}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>Sync activity</h3>
    {#if $syncFailures.length === 0}
      <p>No sync failures.</p>
    {:else}
      <p>
        Last failure: {$syncFailures[$syncFailures.length - 1].operation} —
        {String($syncFailures[$syncFailures.length - 1].error)}
      </p>
    {/if}
    {#if $events.length === 0}
      <p>No activity yet.</p>
    {:else}
      <ul>
        {#each $events.toReversed() as event, i (i)}
          <li>{JSON.stringify(event)}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>Actions</h3>
    <button type="button" onclick={forcePull}>Force pull</button>
    <button type="button" onclick={forcePush}>Force push</button>
    {#if core.offline !== undefined}
      <button type="button" onclick={toggleOffline}>
        {offline === true ? "Go online" : "Simulate offline"}
      </button>
    {/if}
    <h4>Drop a subscription</h4>
    {#if $subscriptions.length === 0}
      <p>No active subscriptions.</p>
    {:else}
      <ul>
        {#each $subscriptions as s, i (i)}
          <li>
            {s.collection}
            <button type="button" onclick={() => dropSubscription(s)}>drop</button>
          </li>
        {/each}
      </ul>
    {/if}
    <h4>Destructive</h4>
    <button type="button" onclick={clearStore}>Clear store…</button>
  </section>
</div>
