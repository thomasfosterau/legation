<script lang="ts">
  /**
   * Customers — directory table with live order counts (a join).
   */
  import { getData, toCustomerCounts } from "../data";

  const { customers, orders } = getData();
  const rows = $derived(toCustomerCounts($customers, $orders));
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
