/**
 * The commerce domain as JSON:API resources (`@thomasfosterau/effect-jsonapi`).
 *
 * This is the app's CORE contract: the naive SSR-only experience works from
 * these endpoints alone (SvelteKit loads fetch them, form actions post to
 * them), and the sync engine layers on top as a progressive enhancement —
 * the same tables, the same authoritative writes, one more consumer.
 *
 * The relationship graph is deliberately acyclic (the library's resource
 * types expand eagerly, so `Product ↔ Variant` can't reference each other):
 * products declare `variants`; a variant carries its `productId` as a plain
 * attribute.
 */
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

export const Category = Resource.make("categories", {
  attributes: {
    name: Schema.String,
    slug: Schema.String,
  },
});

export const Seller = Resource.make("sellers", {
  attributes: {
    name: Schema.String,
  },
});

export const Variant = Resource.make("variants", {
  attributes: {
    productId: Schema.String,
    sku: Schema.String,
    name: Schema.String,
    priceCents: Schema.Number,
    stock: Schema.Number,
  },
});

export const Product = Resource.make("products", {
  attributes: {
    name: Schema.String,
    description: Schema.String,
    priceCents: Schema.Number,
  },
  relationships: {
    category: Relationship.one(() => Category),
    seller: Relationship.one(() => Seller),
    variants: Relationship.many(() => Variant),
  },
});

export const Review = Resource.make("reviews", {
  attributes: {
    authorName: Schema.String,
    rating: Schema.Number,
    body: Schema.String,
    createdAt: Schema.String,
  },
  relationships: {
    product: Relationship.one(() => Product),
  },
});

export const CartItem = Resource.make("cartItems", {
  attributes: {
    qty: Schema.Number,
  },
  relationships: {
    variant: Relationship.one(() => Variant),
  },
});

export const Order = Resource.make("orders", {
  attributes: {
    status: Schema.String,
    totalCents: Schema.Number,
    createdAt: Schema.String,
  },
});

export const OrderItem = Resource.make("orderItems", {
  attributes: {
    qty: Schema.Number,
    priceCents: Schema.Number,
  },
  relationships: {
    order: Relationship.one(() => Order),
    variant: Relationship.one(() => Variant),
  },
});
