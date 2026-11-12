<script lang="ts">
  import { Aggregate, Client, type Query } from "@thomasfosterau/legation";
  import * as Option from "effect/Option";
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useAggregate, useAggregateGrouped, useQuery } from "../../index.svelte.js";

  const {
    runtime,
    read,
    groupBy,
  }: {
    runtime: ClientRuntime;
    read: Query.Read;
    groupBy: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);
  const rows = useQuery(() => read);
  const count = useAggregate(() => read, Aggregate.count);
  // svelte-ignore state_referenced_locally
  const grouped = useAggregateGrouped(() => read, Aggregate.count, groupBy);

  const current = $derived(AsyncResult.getOrElse(rows.current, () => []));
  // The answer's marker rides on the rows the hook emits (#653).
  const completeness = $derived(
    Option.getOrElse(Client.completenessOf(current), () => "unknown")
  );
</script>

<ul>
  {#each current as row (row.id)}
    <li>{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>completeness:{completeness}</p>
<p>count:{AsyncResult.getOrElse(count.current, () => "none")}</p>
<p>grouped:{JSON.stringify(AsyncResult.getOrElse(grouped.current, () => ({})))}</p>
