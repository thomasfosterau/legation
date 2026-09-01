<script lang="ts">
  /**
   * Product row — inline edit of price / stock, plus discontinued and delete.
   *
   * Local edit state is seeded from the row and resynced via `$effect` whenever
   * the underlying product changes (after a save round-trips, or a rebase).
   */
  import { untrack } from "svelte";
  import { getActions } from "./actions";
  import type { ProductView } from "./data";

  const { view }: { view: ProductView } = $props();
  const actions = getActions();

  // Seed local edit state from the row; the `$effect` below keeps it in sync.
  let price = $state(untrack(() => String(view.product.unitPrice)));
  let stock = $state(untrack(() => String(view.product.unitsInStock)));
  let editing = $state(false);

  // Resync local edit state when the row changes underneath us.
  $effect(() => {
    price = String(view.product.unitPrice);
    stock = String(view.product.unitsInStock);
  });

  const save = (): void => {
    void actions.updateProduct({
      id: view.product.id,
      unitPrice: Number(price) || 0,
      unitsInStock: Number(stock) || 0,
      discontinued: view.product.discontinued,
    });
    editing = false;
  };

  const toggleDiscontinued = (): void => {
    void actions.updateProduct({
      id: view.product.id,
      unitPrice: view.product.unitPrice,
      unitsInStock: view.product.unitsInStock,
      discontinued: !view.product.discontinued,
    });
  };
</script>

<tr>
  <td>{view.product.name}</td>
  <td class="muted">{view.categoryName}</td>
  <td class="muted">{view.supplierCompany}</td>
  <td class="num">
    {#if editing}
      <input class="cell-input" bind:value={price} />
    {:else}
      ${view.product.unitPrice.toFixed(2)}
    {/if}
  </td>
  <td class="num">
    {#if editing}
      <input class="cell-input" bind:value={stock} />
    {:else}
      {view.product.unitsInStock}
    {/if}
  </td>
  <td>
    <button
      class={`pill ${view.product.discontinued ? "pill-warn" : "pill-ok"}`}
      onclick={toggleDiscontinued}
      style="cursor: pointer; background: transparent;"
    >
      {view.product.discontinued ? "discontinued" : "active"}
    </button>
  </td>
  <td class="right">
    {#if editing}
      <button class="btn btn-sm btn-primary" onclick={save}>Save</button>
    {:else}
      <button class="btn btn-sm" onclick={() => (editing = true)}>Edit</button>
    {/if}
    <button class="btn btn-sm btn-danger" onclick={() => void actions.deleteProduct(view.product.id)}>
      Delete
    </button>
  </td>
</tr>
