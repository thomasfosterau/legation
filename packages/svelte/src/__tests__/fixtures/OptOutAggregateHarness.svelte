<script lang="ts">
  import { Aggregate } from "@legation/effect";
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useAggregate, useAggregateGrouped } from "../../index.svelte.js";

  const { runtime }: { runtime: ClientRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // Starts opted out (#141): no selection to aggregate over yet.
  let authorId = $state<string | undefined>(undefined);
  const read = () =>
    authorId === undefined ? undefined : { collection: "todos", where: { authorId } };
  // svelte-ignore state_referenced_locally
  const count = useAggregate(read, Aggregate.count);
  // svelte-ignore state_referenced_locally
  const grouped = useAggregateGrouped(read, Aggregate.count, "authorId");
</script>

<button onclick={() => (authorId = "u1")}>select</button>
<button onclick={() => (authorId = undefined)}>clear</button>
<p>count-state:{count.current._tag}{count.current.waiting ? ":waiting" : ""}</p>
<p>count:{AsyncResult.getOrElse(count.current, () => "none")}</p>
<p>grouped-state:{grouped.current._tag}{grouped.current.waiting ? ":waiting" : ""}</p>
<p>grouped:{JSON.stringify(AsyncResult.getOrElse(grouped.current, () => ({})))}</p>
