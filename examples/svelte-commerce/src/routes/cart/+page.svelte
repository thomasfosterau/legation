<script lang="ts">
  import { useMutation, useRelated } from "@legation/svelte/Runes";
  import { myCartItems, registry, type CartItem, type Variant } from "../../lib/domain.js";
  import { cartItemRows, variantRows } from "../../lib/rows.js";

  const { data } = $props();
  const userId = $derived(data.user?.id);

  // Live join: each cart line resolves its variant (name, price, stock) in
  // the service-worker host; seeded from the JSON:API load.
  // svelte-ignore state_referenced_locally
  const cart = useRelated(
    () => ({
      registry,
      collection: "cartItems",
      subset: myCartItems(userId ?? "anonymous"),
      names: ["variant"],
    }),
    {
      initial: cartItemRows(data.lines).map((row) => {
        const variantId = (row.value as CartItem).variantId;
        const variant = variantRows(data.variants).find((v) => v.id === variantId)?.value ?? null;
        return { id: row.id, value: row.value, related: { variant } };
      }),
    }
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

  // Progressive enhancement: the form posts to the JSON:API action without
  // JS; with JS we intercept and journal the offline-capable mutator instead.
  const placeOrder = async (event: SubmitEvent) => {
    event.preventDefault();
    if (userId === undefined) return;
    const rows = await cart.promise;
    if (rows.length === 0) return;
    void mutate("order/place", {
      orderId: `o-${crypto.randomUUID()}`,
      userId,
      createdAt: new Date().toISOString(),
      items: rows.map((row) => {
        const item = row.value as CartItem;
        const variant = row.related["variant"] as Variant | null;
        return {
          cartItemId: item.id,
          variantId: item.variantId,
          qty: item.qty,
          priceCents: variant?.priceCents ?? 0,
        };
      }),
    }).catch(() => undefined);
  };
</script>

<h1>Cart</h1>

{#if userId === undefined}
  <p><a href="/account">Sign in</a> to use the cart.</p>
{:else}
  <svelte:boundary>
    {@const rows = await cart.promise}
    {#if rows.length === 0}
      <p>Cart is empty — <a href="/">browse the catalog</a>.</p>
    {:else}
      <ul>
        {#each rows as row (row.id)}
          {@const item = row.value as CartItem}
          {@const variant = row.related["variant"] as Variant | null}
          <li>
            {variant?.name ?? item.variantId} × {item.qty}
            — ${(((variant?.priceCents ?? 0) * item.qty) / 100).toFixed(2)}
            <button onclick={() => setQty(item, item.qty + 1)}>+</button>
            <button onclick={() => setQty(item, item.qty - 1)}>−</button>
            <form
              method="post"
              action="?/remove"
              style="display:inline"
              onsubmit={(event) => {
                event.preventDefault();
                setQty(item, 0);
              }}
            >
              <input type="hidden" name="id" value={item.id} />
              <button>Remove</button>
            </form>
          </li>
        {/each}
      </ul>
      <p>
        Total: ${(
          rows.reduce((sum, row) => {
            const item = row.value as CartItem;
            const variant = row.related["variant"] as Variant | null;
            return sum + (variant?.priceCents ?? 0) * item.qty;
          }, 0) / 100
        ).toFixed(2)}
      </p>
      <form method="post" action="?/placeOrder" onsubmit={placeOrder}>
        <button>Place order</button>
      </form>
      <p><em>Works offline: the order journals locally and pushes on reconnect.</em></p>
    {/if}
  </svelte:boundary>
{/if}
