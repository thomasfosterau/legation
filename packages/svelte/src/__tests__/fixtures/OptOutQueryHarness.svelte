<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useQuery } from "../../index.svelte.js";

  const { runtime }: { runtime: ClientRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // Starts opted out (#141): the master/detail case — a detail read keyed
  // on a selection that starts empty.
  let selected = $state<string | undefined>(undefined);
  // svelte-ignore state_referenced_locally
  const detail = useQuery(() =>
    selected === undefined ? undefined : { collection: "todos", where: { id: selected } }
  );

  const rows = $derived(AsyncResult.getOrElse(detail.current, () => []));
</script>

<button onclick={() => (selected = "1")}>select</button>
<button onclick={() => (selected = undefined)}>clear</button>
<ul>
  {#each rows as row (row.id)}
    <li>row:{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>state:{detail.current._tag}{detail.current.waiting ? ":waiting" : ""}</p>
