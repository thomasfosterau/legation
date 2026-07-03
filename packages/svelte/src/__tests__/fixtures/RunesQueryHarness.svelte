<script lang="ts">
  import { Aggregate, Predicate, Subset } from "@legation/effect";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../index.js";
  import { useAggregate, useQuery } from "../../runes.svelte.js";

  const { runtime }: { runtime: EffectSyncRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);

  // The hook's subset thunk reads reactive state: flipping `title` must
  // re-subscribe the query (the store API cannot do this).
  let title = $state("match");
  const rows = useQuery(() =>
    Subset.make({ collection: "todos", where: Predicate.eq("title", title) })
  );
  const count = useAggregate(() => Subset.make({ collection: "todos" }), Aggregate.count);

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
