<script lang="ts">
  /**
   * Customers — directory table with live order counts.
   *
   * The count is not a client-side aggregate: the read `include`s the
   * customer's `orders` edge, so each row arrives with its orders resolved and
   * the count is `.length` of what the engine already maintains.
   */
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useQuery } from "@legation/svelte";
  import { allCustomers } from "$lib/domain";
  import { toCustomerCounts } from "$lib/data";

  const rows = useQuery(() => allCustomers);
  const customers = $derived(toCustomerCounts(AsyncResult.getOrElse(rows.current, () => [])));
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
    {#each customers as { customer, orders: orderCount } (customer.id)}
      <tr>
        <td>{customer.company}</td>
        <td class="muted">{customer.contact}</td>
        <td class="muted">{customer.country}</td>
        <td class="num">{orderCount}</td>
      </tr>
    {/each}
  </tbody>
</table>
