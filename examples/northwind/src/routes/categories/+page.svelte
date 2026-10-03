<script lang="ts">
  /**
   * Categories — categories with live product counts, and a create form.
   *
   * The count is the read's `products` edge, resolved onto each row by the
   * engine — no grouping pipeline and no join in the component.
   */
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@thomasfosterau/legation-svelte";
  import { getActions } from "$lib/actions";
  import { allCategories } from "$lib/domain";
  import { toCategoryCounts } from "$lib/data";

  const actions = getActions();
  const result = useQuery(() => allCategories);
  const rows = $derived(toCategoryCounts(AsyncResult.getOrElse(result.current, () => [])));

  let name = $state("");
  let description = $state("");

  const add = (event: SubmitEvent): void => {
    event.preventDefault();
    if (name.trim() === "") return;
    void actions.createCategory({
      id: `c-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      description: description.trim(),
    });
    name = "";
    description = "";
  };
</script>

<div>
  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th>Description</th>
        <th class="num">Products</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as { category, count } (category.id)}
        <tr>
          <td>{category.name}</td>
          <td class="muted">{category.description}</td>
          <td class="num">{count}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="card" style="margin-top: 20px;">
    <h3>Add a category</h3>
    <form class="toolbar" onsubmit={add}>
      <input class="input" placeholder="Name" bind:value={name} />
      <input class="input grow" placeholder="Description" bind:value={description} />
      <button class="btn btn-primary" type="submit">Add category</button>
    </form>
  </div>
</div>
