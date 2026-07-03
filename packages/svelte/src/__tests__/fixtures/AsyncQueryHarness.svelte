<script lang="ts">
  import type { Subset } from "@legation/effect";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../index.js";
  import { useQuery } from "../../runes.svelte.js";

  const {
    runtime,
    subset,
    initial,
  }: {
    runtime: EffectSyncRuntime;
    subset: Subset.Subset;
    initial?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  } = $props();

  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);

  // svelte-ignore state_referenced_locally
  const rows = useQuery(
    () => subset,
    initial !== undefined ? { initial } : undefined
  );
</script>

<svelte:boundary>
  <ul>
    {#each await rows.promise as row (row.id)}
      <li>{(row.value as { title: string }).title}</li>
    {/each}
    <p>loaded:{(await rows.promise).length}</p>
  </ul>

  {#snippet pending()}
    <p>pending…</p>
  {/snippet}

  {#snippet failed(error)}
    <p>failed:{String(error)}</p>
  {/snippet}
</svelte:boundary>
