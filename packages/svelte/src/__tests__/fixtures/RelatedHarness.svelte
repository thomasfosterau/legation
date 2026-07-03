<script lang="ts">
  import type { Collection, Subset } from "@legation/effect";
  import { related } from "../../Query.js";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../Runtime.js";

  const {
    runtime,
    registry,
    collection,
    subset,
    names,
  }: {
    runtime: EffectSyncRuntime;
    registry: Collection.CollectionRegistry;
    collection: string;
    subset: Subset.Subset;
    names: ReadonlyArray<string>;
  } = $props();

  // The store API captures its inputs at init by design — these fixtures
  // never change props after mount.
  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);
  // svelte-ignore state_referenced_locally
  const rows = related(registry, collection, subset, names);

  const authorName = (value: unknown): string =>
    value === null || value === undefined ? "nobody" : (value as { name: string }).name;
</script>

<ul>
  {#each $rows as row (row.id)}
    <li>{(row.value as { title: string }).title}:{authorName(row.related["author"])}</li>
  {/each}
</ul>
