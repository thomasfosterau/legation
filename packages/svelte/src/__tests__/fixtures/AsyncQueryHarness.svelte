<script lang="ts">
  import type { Query } from "@legation/effect";
  import { setClientRuntime, type ClientRuntime } from "../../Runtime.js";
  import { useQuery } from "../../Runes.svelte.js";

  const {
    runtime,
    read,
    initial,
  }: {
    runtime: ClientRuntime;
    read: Query.Read;
    initial?: ReadonlyArray<{
      readonly id: string;
      readonly value: unknown;
      readonly related: Record<string, unknown>;
    }>;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // svelte-ignore state_referenced_locally
  const rows = useQuery(
    () => read,
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
