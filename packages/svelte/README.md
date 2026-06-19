# @thomasfosterau/effect-sync-svelte

Idiomatic Svelte bindings for the
[`@thomasfosterau/effect-sync-core`](../core) engine.

- **`setEngineRuntime(runtime)`** — supply a `ManagedRuntime` that can run
  `ClientEngine` effects (build it from a core composition or
  `JsonApiSync.layer`). Call once, high in the tree, before any query.
- **`query(subset)`** / **`namedQuery(name, args)`** — live results as a Svelte
  `Readable` store; read with `$store` auto-subscription and the component
  re-renders on every local change. The `observe` fiber is torn down when the
  last subscriber unsubscribes.
- **`getMutate()`** — returns a promise-returning `mutate(name, args)` for event
  handlers (optimistic on resolve).

```svelte
<script lang="ts">
  import { query, getMutate } from "@thomasfosterau/effect-sync-svelte";
  import { allTodos } from "./domain";

  const todos = query(allTodos);
  const mutate = getMutate();
</script>

<ul>
  {#each $todos as row (row.id)}
    <li>{row.value.title}</li>
  {/each}
</ul>
<button onclick={() => mutate("todo/set", { id: "1", title: "ship it", done: false })}>
  Add
</button>
```

Pure TypeScript (stores + `setContext`/`getContext`); no `.svelte` components,
so it builds with the same `tsc -b` as the rest of the monorepo. Works with
Svelte 4 stores and Svelte 5 (`$store` auto-subscription is unchanged).

```bash
npm install @thomasfosterau/effect-sync-svelte @thomasfosterau/effect-sync-core effect svelte
```
