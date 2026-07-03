# @legation/svelte

Idiomatic Svelte bindings for the
[`@legation/effect`](../effect) engine.

Coming from TanStack Query / SwiftData / SWR? [Coming from TanStack Query](../../docs/coming-from-tanstack-query.md) maps those libraries' concepts onto this model.

- **`setEngineRuntime(runtime)`** — supply a `ManagedRuntime` that provides a
  `ClientView` (the narrow engine surface, ADR-0021): an engine-backed app
  composes `ClientView.layer.pipe(Layer.provideMerge(engineLayer))`; a
  service-worker deployment provides its `TabMirror` directly. Call once,
  high in the tree, before any query.
- **`query(subset)`** / **`namedQuery(name, args)`** — live results as a Svelte
  `Readable` store; read with `$store` auto-subscription and the component
  re-renders on every local change. The `observe` fiber is torn down when the
  last subscriber unsubscribes.
- **`getMutate()`** — returns a promise-returning `mutate(name, args)` for event
  handlers (optimistic on resolve).
- **`related(registry, collection, subset, names)`** — live join over a
  subset's declared relationships as a `Readable` store (the base and foreign
  collections must already be subscribed).

```svelte
<script lang="ts">
  import { query, getMutate } from "@legation/svelte";
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

## Runes (Svelte 5)

`@legation/svelte/runes` exposes the same reads as rune-based hooks. Each hook
takes its inputs as a **thunk** called inside `$effect`, so a query
re-subscribes whenever the reactive state the thunk reads changes — a
paginated subset whose cursor lives in `$state` just works. Results are
exposed as a reactive `current`
[`AsyncResult`](https://effect.website) (the engine's atom vocabulary): while
re-subscribing the previous value stays visible with `waiting: true`
(stale-while-revalidate).

- **`useQuery(() => subset)`** / **`useNamedQuery(() => ({ name, args }))`**
- **`useAggregate(() => subset, agg)`** / **`useAggregateGrouped(() => subset, agg, groupBy)`**
- **`useRelated(() => ({ registry, collection, subset, names }), { subscribe? })`**
  — with `subscribe: true` it syncs the base and narrowed foreign subsets
  itself and tears them down on unmount.
- **`useMutation()`** / **`useMutationWithAck()`** — aliases of `getMutate` /
  `getMutateWithAck`.

Every live hook accepts `{ initial }` to seed a synchronous `Success` before
the first emission — during SSR (where `$effect` never runs) the seed is what
renders, and on the client it makes the first render match the server markup
(no loading flash).

```svelte
<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useQuery } from "@legation/svelte/runes";
  import { Predicate, Subset } from "@legation/effect";

  let cursor = $state<string | undefined>(undefined);
  const page = useQuery(() =>
    Subset.make({ collection: "products", orderBy: [{ field: "id" }], limit: 20, cursor })
  );
  const rows = $derived(AsyncResult.getOrElse(page.current, () => []));
</script>
```

The runes entry point ships as an uncompiled `.svelte.js` module (compiled by
your bundler's Svelte plugin, the standard Svelte-library convention) and
requires Svelte 5; the store API on the package root remains Svelte-4
compatible.

```bash
npm install @legation/svelte @legation/effect effect svelte
```
