<script lang="ts">
  import { page as kitPage } from "$app/state";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useMutation, useRelated } from "@legation/svelte/runes";
  import {
    registry,
    Products,
    type Product,
    type Review,
    type Seller,
    type Variant,
  } from "../../../lib/domain.js";

  const { data } = $props();

  // A live join over declared relationships: variants, reviews and the
  // seller resolve against the mirror and re-emit when any of them change —
  // reactive to route changes through the thunk.
  const detail = useRelated(() => ({
    registry,
    collection: "products",
    subset: Products.make({ where: (p) => p.eq("id", kitPage.params.id!) }),
    names: ["variants", "reviews", "seller"],
  }));

  const row = $derived(AsyncResult.getOrElse(detail.current, () => [])[0]);
  const product = $derived(row?.value as Product | undefined);
  const variants = $derived((row?.related["variants"] as ReadonlyArray<Variant>) ?? []);
  const reviews = $derived((row?.related["reviews"] as ReadonlyArray<Review>) ?? []);
  const seller = $derived(row?.related["seller"] as Seller | undefined);

  const mutate = useMutation();
  let added = $state("");
  const addToCart = (variant: Variant) => {
    if (data.userId === undefined) return;
    void mutate("cart/add", {
      id: `ci-${crypto.randomUUID()}`,
      userId: data.userId,
      variantId: variant.id,
      qty: 1,
    }).catch(() => undefined);
    added = variant.id;
  };

  let rating = $state(5);
  let body = $state("");
  const submitReview = () => {
    if (data.userId === undefined || product === undefined) return;
    void mutate("review/write", {
      id: `r-${crypto.randomUUID()}`,
      productId: product.id,
      userId: data.userId,
      authorName: data.userId,
      rating,
      body,
      createdAt: new Date().toISOString(),
    }).catch(() => undefined);
    body = "";
  };
</script>

{#if product}
  <h1>{product.name}</h1>
  <p>{product.description}</p>
  <p>Sold by {seller?.name ?? "…"}</p>

  <h2>Variants</h2>
  <ul>
    {#each variants as variant (variant.id)}
      <li>
        {variant.name} — ${(variant.priceCents / 100).toFixed(2)} — stock {variant.stock}
        {#if data.userId}
          <button onclick={() => addToCart(variant)} disabled={variant.stock === 0}>
            {added === variant.id ? "Added ✓" : "Add to cart"}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  <h2>Reviews ({reviews.length})</h2>
  <ul>
    {#each reviews as review (review.id)}
      <li>{review.rating}/5 — {review.body} — {review.authorName}</li>
    {/each}
  </ul>

  {#if data.userId}
    <p>
      <label>Rating <input type="number" min="1" max="5" bind:value={rating} /></label>
      <input placeholder="Write a review…" bind:value={body} />
      <button onclick={submitReview} disabled={body === ""}>Post review</button>
    </p>
  {:else}
    <p><a href="/account">Sign in</a> to buy or review.</p>
  {/if}
{:else}
  <p>Loading product…</p>
{/if}
