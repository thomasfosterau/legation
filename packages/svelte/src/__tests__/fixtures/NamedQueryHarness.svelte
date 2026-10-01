<script lang="ts">
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useNamedQuery } from "../../index.svelte.js";

  const {
    runtime,
    name,
    args,
  }: {
    runtime: ClientRuntime;
    name: string;
    args: unknown;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);
  const rows = useNamedQuery(() => ({ name, args }));
  const current = $derived(AsyncResult.getOrElse(rows.current, () => []));
</script>

<ul>
  {#each current as row (row.id)}
    <li>{(row.value as { title: string }).title}</li>
  {/each}
</ul>
