<script lang="ts">
  import { browser } from "$app/environment";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { Hydration } from "@legation/effect";
  import { useQuery } from "@legation/svelte/runes";
  import { allCategories, productPage, type Category, type Product } from "../lib/domain.js";

  const { data } = $props();

  // Reactive inputs: flipping category or paging re-subscribes the hook —
  // cursor+limit windows are evaluated by Subset.window on both tiers.
  let categoryId = $state<string | undefined>(undefined);
  let cursor = $state<string | undefined>(undefined);
  const PAGE = 4;

  const page = $derived(productPage({ categoryId, cursor, limit: PAGE }));
// svelte-ignore state_referenced_locally
  const productsQuery = useQuery(() => productPage({ categoryId, cursor, limit: PAGE }), {
    initial: browser ? undefined : Hydration.rowsFor(data.snapshot, productPage({ limit: PAGE })),
  });
// svelte-ignore state_referenced_locally
  const categoriesQuery = useQuery(() => allCategories, {
    initial: Hydration.rowsFor(data.snapshot, allCategories),
  });

  const products = $derived(
    AsyncResult.getOrElse(productsQuery.current, () =>
      // Before the first client emission, keep rendering the SSR window.
      Hydration.rowsFor(data.snapshot, page)
    ).map((row) => row.value as Product)
  );
  const categories = $derived(
    AsyncResult.getOrElse(categoriesQuery.current, () => []).map((row) => row.value as Category)
  );

  const nextPage = () => {
    const last = products[products.length - 1];
    if (last !== undefined && products.length === PAGE) cursor = last.id;
  };
  const firstPage = () => (cursor = undefined);
  const pickCategory = (id: string | undefined) => {
    categoryId = id;
    cursor = undefined;
  };
</script>

<h1>Catalog</h1>

<p>
  <button onclick={() => pickCategory(undefined)}>All</button>
  {#each categories as category (category.id)}
    <button onclick={() => pickCategory(category.id)}>{category.name}</button>
  {/each}
</p>

<ul>
  {#each products as product (product.id)}
    <li>
      <a href={`/product/${product.id}`}>{product.name}</a>
      — ${(product.priceCents / 100).toFixed(2)}
    </li>
  {/each}
</ul>

<p>
  <button onclick={firstPage} disabled={cursor === undefined}>First page</button>
  <button onclick={nextPage} disabled={products.length < PAGE}>Next page</button>
</p>
