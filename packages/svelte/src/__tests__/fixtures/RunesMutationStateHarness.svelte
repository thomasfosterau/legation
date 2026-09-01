<script lang="ts">
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useMutation, useMutationState } from "../../index.svelte.js";

  const { runtime }: { runtime: ClientRuntime } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // Reactive scope, like RunesQueryHarness's `title`: flipping it must
  // re-subscribe `useMutationState`'s filtered rune.
  let scope = $state<string | undefined>(undefined);
  const mutate = useMutation();
  // svelte-ignore state_referenced_locally
  const all = useMutationState();
  // svelte-ignore state_referenced_locally
  const scoped = useMutationState(() => scope);
</script>

<button onclick={() => mutate("todo/set", { id: "1", title: "t" })}>mutate</button>
<button onclick={() => (scope = "todo/set")}>scope</button>
<ul>
  {#each all.current._tag === "Success" ? all.current.value : [] as state (state.mutationId)}
    <li>all:{state.mutationId}:{state.phase}</li>
  {/each}
</ul>
<p>scoped-count:{scoped.current._tag === "Success" ? scoped.current.value.length : -1}</p>
