<script lang="ts">
  import { page as kitPage } from "$app/state";
  import { useAggregateGrouped, useQuery } from "@thomasfosterau/legation-svelte";
  import { AsyncResult } from "effect/reactivity";
  import { Aggregate } from "@thomasfosterau/legation-effect";
  import {
    allCategories,
    allVariants,
    CATALOG_PAGE_SIZE,
    productPage,
    type Category,
    type Product,
  } from "../lib/domain.js";
  import { productRows, toRow, variantRows } from "../lib/rows.js";

  const { data } = $props();

  // The category filter and the cursor live in the URL (`?category=`,
  // `?after=`): links keep the no-JS tier working, SPA navigation makes the
  // same links reactive inputs for the live hooks, so both tiers page the
  // one read. Search is enhanced-tier state.
  const categoryId = $derived(kitPage.url.searchParams.get("category") ?? undefined);
  const cursor = $derived(kitPage.url.searchParams.get("after") ?? undefined);
  let search = $state("");

  /** The catalog URL of a page: the current category, at `after`. */
  const pageHref = (after?: string) => {
    const params = new URLSearchParams();
    if (categoryId !== undefined) params.set("category", categoryId);
    if (after !== undefined) params.set("after", after);
    const query = params.toString();
    return query === "" ? "/" : `/?${query}`;
  };
  const PAGE = CATALOG_PAGE_SIZE;

  // svelte-ignore state_referenced_locally
  const productsQuery = useQuery(() => productPage({ categoryId, cursor, limit: PAGE }), {
    // The load fetched exactly this read (the first page, at its canonical
    // URL), so the seed is the window.
    initial: productRows(data.products),
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

  <!-- Plain links: the no-JS visitor pages the same read, one window on. -->
  <p>
    {#if cursor !== undefined}<a href={pageHref()}>First page</a>{/if}
    {#if data.nextCursor !== undefined}<a href={pageHref(data.nextCursor)}>Next page</a>{/if}
  </p>
</svelte:boundary>
