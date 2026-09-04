<script lang="ts">
  import { page as kitPage } from "$app/state";
  import { Aggregate } from "@legation/effect";
  import { useAggregate, useConnection, useMutationWithAck, useQuery } from "@legation/svelte";
  import {
    productDetail,
    productReviews,
    type Product,
    type Review,
    type Seller,
    type Variant,
  } from "../../../lib/domain.js";
  import { reviewRows, sellerRows, toRow, variantRows } from "../../../lib/rows.js";

  const { data } = $props();

  // A live join over the read's `include`d edges: variants, reviews and
  // the seller resolve in the ENGINE HOST (the service worker — this tab
  // only receives resolved rows) and re-emit when any of them change.
  // Reactive to route changes through the thunk; seeded by the JSON:API
  // load. Observing IS subscribing — the hook registers its own windows.
  // svelte-ignore state_referenced_locally
  const detail = useQuery(
    () => productDetail(kitPage.params.id!),
    {
      initial: [
        {
          ...toRow(data.product, ["category", "seller"]),
          related: {
            variants: variantRows(data.variants).map((row) => row.value),
            seller: data.seller === undefined ? null : sellerRows([data.seller])[0]!.value,
          },
        },
      ],
    }
  );

  // This product's reviews as a growing connection (ADR-0024): "Load more"
  // widens the one window a page at a time, so only the shown reviews sync —
  // not the whole feed. Seeded from the JSON:API load for a flash-free first
  // paint. Each product page owns its own connection, so paging is per-parent.
  const REVIEW_PAGE = 3;
  // svelte-ignore state_referenced_locally
  const reviews = useConnection(() => productReviews(kitPage.params.id!), {
    pageSize: REVIEW_PAGE,
    initial: reviewRows(data.reviews).slice(0, REVIEW_PAGE),
  });

  // Live average rating over this product's synced reviews.
  // svelte-ignore state_referenced_locally
  const rating = useAggregate(
    () => productReviews(kitPage.params.id!),
    Aggregate.avg("rating"),
    {
      initial:
        data.reviews.length === 0
          ? undefined
          : data.reviews.reduce((sum, review) => sum + Number(review.attributes.rating), 0) /
            data.reviews.length,
    }
  );

  const mutateWithAck = useMutationWithAck();
  let added = $state("");
  const addToCart = (variant: Variant) => {
    if (data.user === undefined) return;
    void mutateWithAck("cart/add", {
      id: `ci-${crypto.randomUUID()}`,
      userId: data.user.id,
      variantId: variant.id,
      qty: 1,
    }).catch(() => undefined);
    added = variant.id;
  };
</script>

<svelte:boundary>
  {@const row = (await detail.promise)[0]}
  {@const product = row?.value as Product | undefined}
  {@const variants = (row?.related["variants"] as ReadonlyArray<Variant>) ?? []}
  {@const seller = row?.related["seller"] as Seller | null}

  {#if product}
    <h1>{product.name}</h1>
    <p>{product.description}</p>
    <p>
      Sold by {seller?.name ?? "…"}
      {#await rating.promise then average}
        {#if average !== undefined}— rated {Number(average).toFixed(1)}/5{/if}
      {/await}
    </p>

    <h2>Variants</h2>
    <ul>
      {#each variants as variant (variant.id)}
        <li>
          {variant.name} — ${(variant.priceCents / 100).toFixed(2)} — stock {variant.stock}
          {#if data.user}
            <!-- Enhanced: the sync mutator (offline-capable journal). The
                 plain form below is the no-JS path through the JSON:API. -->
            <button onclick={() => addToCart(variant)} disabled={variant.stock === 0}>
              {added === variant.id ? "Added ✓" : "Add to cart"}
            </button>
          {:else}
            <form method="post" action="?/addToCart" style="display:inline">
              <input type="hidden" name="variantId" value={variant.id} />
              <button disabled={variant.stock === 0}>Add to cart</button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>

    <h2>Reviews</h2>
    <ul>
      {#each await reviews.promise as reviewRow (reviewRow.id)}
        {@const review = reviewRow.value as Review}
        <li>{review.rating}/5 — {review.body} — {review.authorName}</li>
      {/each}
    </ul>
    {#if reviews.hasMore}
      <button onclick={reviews.loadMore} disabled={reviews.loading}>
        {reviews.loading ? "Loading…" : "Load more reviews"}
      </button>
    {/if}

    {#if data.user}
      <form method="post" action="?/review">
        <label>Rating <input type="number" name="rating" min="1" max="5" value="5" /></label>
        <input name="body" placeholder="Write a review…" required />
        <button>Post review</button>
      </form>
    {:else}
      <p><a href="/account">Sign in</a> to buy or review.</p>
    {/if}
  {:else}
    <p>No such product.</p>
  {/if}
</svelte:boundary>
