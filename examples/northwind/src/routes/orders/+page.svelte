<script lang="ts">
  /**
   * Orders — orders with customer/employee, computed totals, expandable line
   * items, and a "ship" action (the read-merge `order/ship` mutation).
   *
   * Two reads, both joined by the engine. `allOrders` `include`s each order's
   * `customer`, `employee` and `lines`, so the row and its total come straight
   * off the resolved row. The expanded line items are a **reactive** read: the
   * hook's thunk closes over `open`, so opening a different order re-subscribes
   * to that order's lines — with each line's `product` edge resolved — and the
   * previous rows stay on screen while it resolves.
   */
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@thomasfosterau/legation-svelte";
  import { getActions } from "$lib/actions";
  import { lineTotal, toOrderLines, toOrderViews } from "$lib/data";
  import { allOrders, orderLines } from "$lib/domain";

  const actions = getActions();
  const orderRows = useQuery(() => allOrders);

  let open = $state<string | null>(null);

  // The read is rebuilt whenever `open` changes; `undefined` opts the hook
  // out entirely while no panel is expanded (#141) — no window registered,
  // no request issued.
  const lineRows = useQuery(() => (open === null ? undefined : orderLines(open)));

  const views = $derived(toOrderViews(AsyncResult.getOrElse(orderRows.current, () => [])));
  const lines = $derived(toOrderLines(AsyncResult.getOrElse(lineRows.current, () => [])));

  const money = (n: number): string => `$${n.toFixed(2)}`;
  const date = (ms: number): string => new Date(ms).toLocaleDateString();
  const toggle = (id: string): void => {
    open = open === id ? null : id;
  };
</script>

<table>
  <thead>
    <tr>
      <th>Order</th>
      <th>Customer</th>
      <th>Rep</th>
      <th>Ordered</th>
      <th>Status</th>
      <th class="num">Total</th>
      <th class="right">Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each views as view (view.order.id)}
      <tr>
        <td>
          <button class="linkish" onclick={() => toggle(view.order.id)}>
            #{view.order.id} ({view.lineCount})
          </button>
        </td>
        <td>{view.customerCompany}</td>
        <td class="muted">{view.employeeName}</td>
        <td class="muted">{date(view.order.orderedAt)}</td>
        <td>
          {#if view.order.shippedAt === null}
            <span class="pill pill-warn">open</span>
          {:else}
            <span class="pill pill-ok">shipped {date(view.order.shippedAt)}</span>
          {/if}
        </td>
        <td class="num">{money(view.total)}</td>
        <td class="right">
          {#if view.order.shippedAt === null}
            <button class="btn btn-sm btn-primary" onclick={() => void actions.shipOrder(view.order.id)}>
              Ship
            </button>
          {/if}
        </td>
      </tr>
      {#if open === view.order.id}
        <tr class="lines">
          <td colspan={7}>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th class="num">Unit price</th>
                  <th class="num">Qty</th>
                  <th class="num">Discount</th>
                  <th class="num">Line total</th>
                </tr>
              </thead>
              <tbody>
                {#each lines as { detail, productName } (detail.id)}
                  <tr>
                    <td>{productName}</td>
                    <td class="num">{money(detail.unitPrice)}</td>
                    <td class="num">{detail.quantity}</td>
                    <td class="num">{detail.discount > 0 ? `${detail.discount * 100}%` : "—"}</td>
                    <td class="num">{money(lineTotal(detail))}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </td>
        </tr>
      {/if}
    {/each}
  </tbody>
</table>
