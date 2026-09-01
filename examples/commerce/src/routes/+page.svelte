<script lang="ts">
  import { page as kitPage } from "$app/state";
  import { useAggregateGrouped, useQuery } from "@legation/svelte";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { Aggregate } from "@legation/effect";
  import { allCategories, allVariants, productPage, type Category, type Product } from "../lib/domain.js";
  import { productRows, toRow, variantRows } from "../lib/rows.js";

  const { data } = $props();

  // The category filter lives in the URL (`?category=`): links keep the
  // no-JS tier working, SPA navigation makes the same links reactive inputs
  // for the live hooks. The cursor and search are enhanced-tier state.
  const categoryId = $derived(kitPage.url.searchParams.get("category") ?? undefined);
  let cursor = $state<string | undefined>(undefined);
  let search = $state("");
  const PAGE = 4;

  // svelte-ignore state_referenced_locally
  const productsQuery = useQuery(() => productPage({ categoryId, cursor, limit: PAGE }), {
    // The load returns the whole (filtered) list; the subset's window is the
    // first page.
    initial: productRows(data.products).slice(0, PAGE),
  });
  // svelte-ignore state_referenced_locally
  const categoriesQuery = useQuery(() => allCategories, {
    initial: data.categories.map((category) => toRow(category)),
  });
  // Grouped live aggregate: per-product stock from the variants the engine
  // has synced — the "out of stock" badges update as orders decrement stock.
  // svelte-ignore state_referenced_locally
  const stock = useAggregateGrouped(() => allVariants, Aggregate.sum("stock"), "productId", {
    initial: variantRows(data.variants).reduce<Record<string, number>>((sums, row) => {
      const value = row.value as { productId?: string; stock?: number };
      const key = value.productId ?? "";
      sums[key] = (sums[key] ?? 0) + (value.stock ?? 0);
      return sums;
    }, {}),
  });

  const products = $derived.by(async () => {
    // Read reactive inputs BEFORE the first await (Svelte tracks sync reads).
    const needle = search.trim().toLowerCase();
    const rows = await productsQuery.promise;
    return rows
      .map((row) => row.value as Product)
      .filter((product) => needle === "" || product.name.toLowerCase().includes(needle));
  });
  const stockOf = $derived(AsyncResult.getOrElse(stock.current, () => ({})) as Record<string, number>);

  const nextPage = async () => {
    const rows = await productsQuery.promise;
    const last = rows[rows.length - 1];
    if (last !== undefined && rows.length === PAGE) cursor = last.id;
  };
  const firstPage = () => (cursor = undefined);
</script>

<h1>Catalog</h1>

<svelte:boundary>
  <p>
    <a href="/">All</a>
    {#each await categoriesQuery.promise as row (row.id)}
      {@const category = row.value as Category}
      <a href={`/?category=${category.id}`}>{category.name}</a>
    {/each}
    <input placeholder="Search…" bind:value={search} />
  </p>

  <ul>
    {#each await products as product (product.id)}
      <li>
        <a href={`/product/${product.id}`}>{product.name}</a>
        — ${(product.priceCents / 100).toFixed(2)}
        {#if (stockOf[product.id] ?? 1) <= 0}<em> (out of stock)</em>{/if}
      </li>
    {/each}
  </ul>

  <p>
    <button onclick={firstPage} disabled={cursor === undefined}>First page</button>
    <button onclick={nextPage}>Next page</button>
  </p>
</svelte:boundary>
