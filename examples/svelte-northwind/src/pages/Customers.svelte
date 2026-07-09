<script lang="ts">
  /**
   * Customers — directory table with live order counts (a join).
   */
  import { getData } from "../data";

  // `customerCounts` is a `Derive` join over customers and orders-grouped-by-
  // customer, maintained incrementally by the engine; sort by company for display.
  const { customerCounts } = getData();
  const rows = $derived(
    [...$customerCounts].sort((a, b) => a.customer.company.localeCompare(b.customer.company))
  );
</script>

<table>
  <thead>
    <tr>
      <th>Company</th>
      <th>Contact</th>
      <th>Country</th>
      <th class="num">Orders</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as { customer, orders: orderCount } (customer.id)}
      <tr>
        <td>{customer.company}</td>
        <td class="muted">{customer.contact}</td>
        <td class="muted">{customer.country}</td>
        <td class="num">{orderCount}</td>
      </tr>
    {/each}
  </tbody>
</table>
