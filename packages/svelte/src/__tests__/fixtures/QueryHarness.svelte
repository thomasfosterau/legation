<script lang="ts">
  import { Aggregate, type Query } from "@thomasfosterau/legation";
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import {
    useAggregate,
    useAggregateGrouped,
    useAnswer,
    useQuery,
  } from "../../index.svelte.js";

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
  const answer = useAnswer(() => read);
  const count = useAggregate(() => read, Aggregate.count);
  // svelte-ignore state_referenced_locally
  const grouped = useAggregateGrouped(() => read, Aggregate.count, groupBy);

  const current = $derived(AsyncResult.getOrElse(rows.current, () => []));
  // The answer's completeness, beside its rows (#653).
  const completeness = $derived(
    AsyncResult.getOrElse(
      AsyncResult.map(answer.current, (value) => `${value.completeness}/${value.rows.length}`),
      () => "none"
    )
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
