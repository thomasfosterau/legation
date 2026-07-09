<script lang="ts">
  /**
   * Orders — orders with customer/employee, computed totals, expandable line
   * items, and a "ship" action (the read-merge `order/ship` mutator).
   */
  import { getActions } from "../actions";
  import { getData, lineTotal, toOrderLines } from "../data";

  const actions = getActions();
  // `orderViews` is a `Derive` join/group pipeline (orders ⋈ customers ⋈
  // employees ⋈ rolled-up line items) the engine maintains incrementally; the
  // screen just orders it for display.
  const { orderViews, orderDetails, products } = getData();

  const views = $derived([...$orderViews].sort((a, b) => b.order.orderedAt - a.order.orderedAt));

  let open = $state<string | null>(null);

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
        {@const lines = toOrderLines(view.order.id, $orderDetails, $products)}
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
