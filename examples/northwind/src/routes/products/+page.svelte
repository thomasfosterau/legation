<script lang="ts">
  /**
   * Products — searchable, category-filtered, paginated grid with inline edits.
   *
   * The grid's join is in its read: `allProducts` `include`s each product's
   * `category` and `supplier`, so a row arrives with the names it displays.
   * Search, category filter and paging stay client-local over the synced set.
   *
   * Each row's price / stock / discontinued is editable; saving issues the
   * read-merge `product/update` mutation (optimistic, then authoritative).
   */
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@legation/svelte";
  import { getActions } from "$lib/actions";
  import { toProductViews, values } from "$lib/data";
  import type { ProductFilter } from "$lib/data";
  import { allCategories, allProducts, type Category } from "$lib/domain";
  import ProductRow from "$lib/ProductRow.svelte";

  const PAGE_SIZE = 8;

  const actions = getActions();
  const productRows = useQuery(() => allProducts);
  const categoryRows = useQuery(() => allCategories);

  let search = $state("");
  let categoryId = $state<string | null>(null);
  let page = $state(0);

  const categories = $derived(
    values<Category>(AsyncResult.getOrElse(categoryRows.current, () => []))
  );
  const filter = $derived<ProductFilter>({ search, categoryId });
  const views = $derived(
    toProductViews(filter, AsyncResult.getOrElse(productRows.current, () => []))
  );
  const pages = $derived(Math.ceil(views.length / PAGE_SIZE));
  const pageViews = $derived(views.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE));

  // Reset to the first page whenever the filter changes.
  $effect(() => {
    search;
    categoryId;
    page = 0;
  });

  // New-product form.
  let name = $state("");
  let newCategoryId = $state("");
  let newPrice = $state("");

  const add = (event: SubmitEvent): void => {
    event.preventDefault();
    if (name.trim() === "") return;
    actions
      .createProduct({
        id: `p-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim(),
        categoryId: newCategoryId || categories[0]?.id || "1",
        supplierId: "1",
        unitPrice: Number(newPrice) || 0,
        unitsInStock: 0,
        discontinued: false,
      })
      .catch(() => undefined);
    name = "";
    newPrice = "";
  };
</script>

<div>
  <div class="toolbar">
    <input class="input grow" placeholder="Search products…" bind:value={search} />
    <select
      class="select"
      value={categoryId ?? ""}
      onchange={(e) => (categoryId = e.currentTarget.value === "" ? null : e.currentTarget.value)}
    >
      <option value="">All categories</option>
      {#each categories as c (c.id)}
        <option value={c.id}>{c.name}</option>
      {/each}
    </select>
    <span class="muted">{views.length} products</span>
  </div>

  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Category</th>
        <th>Supplier</th>
        <th class="num">Price</th>
        <th class="num">In stock</th>
        <th>Status</th>
        <th class="right">Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each pageViews as view (view.product.id)}
        <ProductRow {view} />
      {/each}
      {#if pageViews.length === 0}
        <tr>
          <td colspan={7} class="muted">No products match.</td>
        </tr>
      {/if}
    </tbody>
  </table>

  {#if pages > 1}
    <div class="pagination">
      {#each Array.from({ length: pages }, (_, i) => i) as i (i)}
        <button class={`page-btn ${i === page ? "active" : ""}`} onclick={() => (page = i)}>
          {i + 1}
        </button>
      {/each}
    </div>
  {/if}

  <div class="card" style="margin-top: 20px;">
    <h3>Add a product</h3>
    <form class="toolbar" onsubmit={add}>
      <input class="input grow" placeholder="New product name" bind:value={name} />
      <select class="select" bind:value={newCategoryId}>
        {#each categories as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
      <input class="input" style="width: 100px;" placeholder="Price" bind:value={newPrice} />
      <button class="btn btn-primary" type="submit">Add product</button>
    </form>
  </div>
</div>
