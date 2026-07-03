<script lang="ts">
  import { useQuery } from "@legation/svelte/runes";
  import { myOrders, type Order } from "../../lib/domain.js";
  import { orderRows } from "../../lib/rows.js";

  const { data } = $props();
  const userId = $derived(data.user?.id);

  // svelte-ignore state_referenced_locally
  const ordersQuery = useQuery(() => myOrders(userId ?? "anonymous"), {
    initial: orderRows(data.orders),
  });

  // A non-UI live-query consumer: watch order statuses and notify when the
  // fulfilment worker (an out-of-band writer on the sync server) advances
  // one — the polling hint source pokes, the engine pulls, this re-runs.
  const seen = new Map<string, Order["status"]>();
  $effect(() => {
    void ordersQuery.promise.then((rows) => {
      for (const row of rows) {
        const order = row.value as Order;
        const previous = seen.get(order.id);
        if (previous !== undefined && previous !== order.status) {
          notify(`Order ${order.id.slice(0, 10)}… is now ${order.status}`);
        }
        seen.set(order.id, order.status);
      }
    });
  });

  const notify = (message: string) => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") new Notification(message);
    else console.info(`[order-status] ${message}`);
  };

  const enableNotifications = () => {
    if (typeof Notification !== "undefined") void Notification.requestPermission();
  };
</script>

<h1>Orders</h1>

{#if userId === undefined}
  <p><a href="/account">Sign in</a> to see your orders.</p>
{:else}
  <p>
    <button onclick={enableNotifications}>Enable status notifications</button>
    <em>Placed orders ship ~15s later, deliver ~45s later (the fulfilment worker).</em>
  </p>
  <svelte:boundary>
    <ul>
      {#each await ordersQuery.promise as row (row.id)}
        {@const order = row.value as Order}
        <li>
          {order.createdAt} — <strong>{order.status}</strong> — ${(order.totalCents / 100).toFixed(2)}
        </li>
      {/each}
    </ul>

    {#snippet pending()}
      <p>Loading orders…</p>
    {/snippet}
  </svelte:boundary>
{/if}
