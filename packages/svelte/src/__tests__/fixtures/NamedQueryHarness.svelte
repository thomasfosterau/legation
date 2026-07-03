<script lang="ts">
  import { namedQuery, setEngineRuntime, type EffectSyncRuntime } from "../../index.js";

  const {
    runtime,
    name,
    args,
  }: {
    runtime: EffectSyncRuntime;
    name: string;
    args: unknown;
  } = $props();

  // The store API captures its inputs at init by design — these fixtures
  // never change props after mount.
  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);
  // svelte-ignore state_referenced_locally
  const rows = namedQuery(name, args);
</script>

<ul>
  {#each $rows as row (row.id)}
    <li>{(row.value as { title: string }).title}</li>
  {/each}
</ul>
