<script lang="ts">
  import { AsyncResult } from "effect/unstable/reactivity";
  import { Hydration } from "@legation/effect";
  import { useMutation, useRelated } from "@legation/svelte/runes";
  import { myCartItems, registry, type CartItem, type Variant } from "../../lib/domain.js";

  const { data } = $props();
  const userId = $derived(data.userId);

  // Live join: each cart line resolves its variant (name, price, stock).
// svelte-ignore state_referenced_locally
  const cart = useRelated(
    () => ({
      registry,
      collection: "cartItems",
      subset: myCartItems(userId ?? "anonymous"),
      names: ["variant"],
    }),
    {
      initial:
        userId === undefined
          ? []
          : Hydration.rowsFor(data.snapshot, myCartItems(userId)).map((row) => ({
              id: row.id,
              value: row.value,
              related: {},
            })),
    }
  );

  const lines = $derived(
    AsyncResult.getOrElse(cart.current, () => []).map((row) => ({
      item: row.value as CartItem,
      variant: row.related["variant"] as Variant | undefined,
    }))
  );
  const total = $derived(
    lines.reduce((sum, line) => sum + (line.variant?.priceCents ?? 0) * line.item.qty, 0)
  );

  const mutate = useMutation();
  const setQty = (item: CartItem, qty: number) => {
    if (userId === undefined) return;
    void (
      qty <= 0
        ? mutate("cart/remove", { id: item.id, userId })
        : mutate("cart/setQty", { id: item.id, userId, qty })
    ).catch(() => undefined);
  };

  const placeOrder = () => {
    if (userId === undefined || lines.length === 0) return;
    void mutate("order/place", {
      orderId: `o-${crypto.randomUUID()}`,
      userId,
      createdAt: new Date().toISOString(),
      items: lines.map((line) => ({
        cartItemId: line.item.id,
        variantId: line.item.variantId,
        qty: line.item.qty,
        priceCents: line.variant?.priceCents ?? 0,
      })),
    }).catch(() => undefined);
  };
</script>

<h1>Cart</h1>

{#if userId === undefined}
  <p><a href="/account">Sign in</a> to use the cart.</p>
{:else if lines.length === 0}
  <p>Cart is empty — <a href="/">browse the catalog</a>.</p>
{:else}
  <ul>
    {#each lines as line (line.item.id)}
      <li>
        {line.variant?.name ?? line.item.variantId} × {line.item.qty}
        — ${(((line.variant?.priceCents ?? 0) * line.item.qty) / 100).toFixed(2)}
        <button onclick={() => setQty(line.item, line.item.qty + 1)}>+</button>
        <button onclick={() => setQty(line.item, line.item.qty - 1)}>−</button>
        <button onclick={() => setQty(line.item, 0)}>Remove</button>
      </li>
    {/each}
  </ul>
  <p>Total: ${(total / 100).toFixed(2)}</p>
  <button onclick={placeOrder}>Place order</button>
  <p><em>Works offline: the order journals locally and pushes on reconnect.</em></p>
{/if}
