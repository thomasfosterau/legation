<script lang="ts">
  import * as Option from "effect/Option";
  import type { Query } from "@thomasfosterau/legation-effect";
  import { AsyncResult } from "effect/reactivity";
  import { getClient, setClient, useQuery, type ClientHandle } from "../../index.svelte.js";

  const {
    client,
    read,
  }: {
    client: ClientHandle | undefined;
    read: Query.Read;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClient(client);
  const present = Option.isSome(getClient());
  const rows = useQuery(() => read);
</script>

<p>client:{present ? "set" : "none"}</p>
{#if AsyncResult.isFailure(rows.current)}
  <p>failed:{String(AsyncResult.isFailure(rows.current) ? rows.current.cause : "")}</p>
{:else}
  <ul>
    {#each AsyncResult.getOrElse(rows.current, () => []) as row (row.id)}
      <li>{(row.value as { title: string }).title}</li>
    {/each}
  </ul>
{/if}
