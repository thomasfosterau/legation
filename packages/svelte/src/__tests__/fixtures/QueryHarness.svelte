<script lang="ts">
  import { Aggregate } from "@legation/effect";
import { type Subset } from "@legation/effect/internal";
  import { aggregate, aggregateGrouped, query } from "../../Query.js";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../Runtime.js";

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
