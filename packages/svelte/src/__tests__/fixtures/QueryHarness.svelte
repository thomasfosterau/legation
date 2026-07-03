<script lang="ts">
  import { Aggregate, type Subset } from "@legation/effect";
  import {
    aggregate,
    aggregateGrouped,
    query,
    setEngineRuntime,
    type EffectSyncRuntime,
  } from "../../index.js";

  const {
    runtime,
    subset,
    groupBy,
  }: {
    runtime: EffectSyncRuntime;
    subset: Subset.Subset;
    groupBy: string;
  } = $props();

  // The store API captures its inputs at init by design (same rule as
  // getContext) — these fixtures never change props after mount.
  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);
  // svelte-ignore state_referenced_locally
  const rows = query(subset);
  // svelte-ignore state_referenced_locally
  const count = aggregate(subset, Aggregate.count);
  // svelte-ignore state_referenced_locally
  const grouped = aggregateGrouped(subset, Aggregate.count, groupBy);
</script>

<ul>
  {#each $rows as row (row.id)}
    <li>{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>count:{$count === undefined ? "none" : $count}</p>
<p>grouped:{JSON.stringify($grouped)}</p>
