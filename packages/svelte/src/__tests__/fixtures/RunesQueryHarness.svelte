<script lang="ts">
  import { Aggregate } from "@legation/effect";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../Runtime.js";
  import { useAggregate, useQuery } from "../../Runes.svelte.js";

  const {
    runtime,
    initial,
  }: {
    runtime: ClientRuntime;
    initial?: ReadonlyArray<{
      readonly id: string;
      readonly value: unknown;
      readonly related: Record<string, unknown>;
    }>;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // The hook's read thunk reads reactive state: flipping `title` must
  // re-subscribe the query (the store API cannot do this).
  let title = $state("match");
  // svelte-ignore state_referenced_locally
  const rows = useQuery(() => ({ collection: "todos", where: { title } }), { initial });
  const count = useAggregate(() => ({ collection: "todos" }), Aggregate.count);

  const current = $derived(AsyncResult.getOrElse(rows.current, () => []));
</script>

<button onclick={() => (title = "other")}>switch</button>
<ul>
  {#each current as row (row.id)}
    <li>row:{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>state:{rows.current._tag}{rows.current.waiting ? ":waiting" : ""}</p>
<p>count:{AsyncResult.getOrElse(count.current, () => "none")}</p>
