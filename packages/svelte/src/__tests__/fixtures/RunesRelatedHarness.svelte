<script lang="ts">
  import type { Query } from "@legation/effect";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../Runtime.js";
  import { useQuery } from "../../Runes.svelte.js";

  const {
    runtime,
    read,
  }: {
    runtime: ClientRuntime;
    read: Query.Read;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // svelte-ignore state_referenced_locally
  const rows = useQuery(() => read);

  const joined = $derived(
    AsyncResult.getOrElse(rows.current, () => []).map((row) => {
      const author = row.related["author"];
      const name =
        author === null || author === undefined ? "nobody" : (author as { name: string }).name;
      return `${(row.value as { title: string }).title}:${name}`;
    })
  );
</script>

<ul>
  {#each joined as entry (entry)}
    <li>{entry}</li>
  {/each}
</ul>
