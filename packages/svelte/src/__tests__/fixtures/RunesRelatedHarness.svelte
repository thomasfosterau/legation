<script lang="ts">
  import type { Collection, Subset } from "@legation/effect";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../Runtime.js";
  import { useRelated } from "../../Runes.svelte.js";

  const {
    runtime,
    registry,
    collection,
    subset,
    names,
    subscribe = false,
  }: {
    runtime: EffectSyncRuntime;
    registry: Collection.CollectionRegistry;
    collection: string;
    subset: Subset.Subset;
    names: ReadonlyArray<string>;
    subscribe?: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);

  // svelte-ignore state_referenced_locally
  const rows = useRelated(() => ({ registry, collection, subset, names }), { subscribe });

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
