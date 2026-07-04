<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../Runtime.js";
  import { useConnection } from "../../Runes.svelte.js";

  const {
    runtime,
    authorId,
    pageSize = 2,
    label = "row",
  }: {
    runtime: ClientRuntime;
    authorId?: string;
    pageSize?: number;
    label?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // A per-parent connection: scoping `where` to one author and giving each
  // its own hook instance is what makes the paging independent.
  // svelte-ignore state_referenced_locally
  const conn = useConnection(
    () => ({
      collection: "todos",
      ...(authorId === undefined ? {} : { where: { authorId } }),
      order: ["id"],
    }),
    { pageSize }
  );

  const rows = $derived(AsyncResult.getOrElse(conn.current, () => []));
</script>

<button onclick={conn.loadMore}>{label}:more</button>
<button onclick={conn.reset}>{label}:reset</button>
<ul>
  {#each rows as row (row.id)}
    <li>{label}:{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>{label}-count:{rows.length}</p>
<p>{label}-hasMore:{conn.hasMore}</p>
