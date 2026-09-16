<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useNamedQuery } from "../../index.svelte.js";

  const { runtime }: { runtime: ClientRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // Starts opted out (#141): no title chosen yet.
  let title = $state<string | undefined>(undefined);
  // svelte-ignore state_referenced_locally
  const rows = useNamedQuery(() =>
    title === undefined ? undefined : { name: "todos/byTitle", args: { title } }
  );

  const current = $derived(AsyncResult.getOrElse(rows.current, () => []));
</script>

<button onclick={() => (title = "match")}>select</button>
<button onclick={() => (title = undefined)}>clear</button>
<ul>
  {#each current as row (row.id)}
    <li>row:{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>state:{rows.current._tag}{rows.current.waiting ? ":waiting" : ""}</p>
