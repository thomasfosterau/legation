<script lang="ts">
  /**
   * Suppliers — read-only directory table.
   */
  import { getData } from "$lib/data";

  const { suppliers } = getData();
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
    {#each $suppliers as s (s.id)}
      <tr>
        <td>{s.company}</td>
        <td class="muted">{s.contact}</td>
        <td class="muted">{s.country}</td>
      </tr>
    {/each}
  </tbody>
</table>
