<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useConnection } from "../../index.svelte.js";

  const { runtime }: { runtime: ClientRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // Starts opted out (#141): per-parent paging with no parent selected yet.
  // `include`s an edge so the hook takes its ledger-registering fallback
  // path (ADR-0024's "a joined read falls back to resubscribe-per-page"),
  // which is what registers through `engine.activeSubscriptions` — the
  // engine-level retarget path (#133) reuses an already-open observation
  // instead and never touches that ledger.
  let authorId = $state<string | undefined>(undefined);
  // svelte-ignore state_referenced_locally
  const conn = useConnection(() =>
    authorId === undefined
      ? undefined
      : { collection: "todos", where: { authorId }, order: ["id"], include: { author: true } }
  );

  const rows = $derived(AsyncResult.getOrElse(conn.current, () => []));
</script>

<button onclick={() => (authorId = "u1")}>select</button>
<button onclick={() => (authorId = undefined)}>clear</button>
<ul>
  {#each rows as row (row.id)}
    <li>row:{(row.value as { title: string }).title}</li>
  {/each}
</ul>
<p>state:{conn.current._tag}{conn.current.waiting ? ":waiting" : ""}</p>
<p>hasMore:{conn.hasMore}</p>
