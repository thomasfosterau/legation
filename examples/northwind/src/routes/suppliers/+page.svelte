<script lang="ts">
  /**
   * Suppliers — read-only directory table.
   */
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useQuery } from "@legation/svelte/Runes";
  import { allSuppliers, type Supplier } from "$lib/domain";
  import { values } from "$lib/data";

  const rows = useQuery(() => allSuppliers);
  const suppliers = $derived(values<Supplier>(AsyncResult.getOrElse(rows.current, () => [])));
</script>

<table>
  <thead>
    <tr>
      <th>Company</th>
      <th>Contact</th>
      <th>Country</th>
    </tr>
  </thead>
  <tbody>
    {#each suppliers as s (s.id)}
      <tr>
        <td>{s.company}</td>
        <td class="muted">{s.contact}</td>
        <td class="muted">{s.country}</td>
      </tr>
    {/each}
  </tbody>
</table>
