/**
 * The commerce domain as JSON:API resources (`@thomasfosterau/effect-jsonapi`).
 *
 * This is the app's CORE contract: the naive SSR-only experience works from
 * these endpoints alone (SvelteKit loads fetch them, form actions post to
 * them), and the sync engine layers on top as a progressive enhancement —
 * the same tables, the same authoritative writes, one more consumer.
 *
 * The resources describe the same tables as the node graph in
 * `src/lib/domain.ts`, and the two agree declaration for declaration
 * (`tests/derived-rest.test.ts` bridges these resources through
 * `NodeBridge.registry` and compares): a resource's relationships are the
 * node's edges, its attributes the node's attributes, and its filterable /
 * sortable declarations (ADR-0028, #154 — `Filter.able` / `Sort.able`, or the
 * `filter` / `sort` sugar of `Resource.attribute`) the node's filterable set.
 * The `list` / `get` endpoints are derived from the node graph
 * (`RestHandlers`, #163), so what a resource declares is what its documents
 * carry: `userId` is an attribute of the private collections because the
 * sync tier ships it and the auth policy scopes by it (server-set — never a
 * create input — and filterable by `eq`, the one filter the app's own reads
 * use on it).
 *
 * Every attribute is `resource: "optional"`: a sparse fieldset
 * (`fields[products]=name`) leaves the others out of the resource object,
 * and the endpoint's success encoder must accept that (ADR-0029 §5 — a
 * projection at serialisation over full rows). Create payloads still require
 * them (`create` defaults to `"required"`).
 *
 * The relationship graph is deliberately acyclic (the library's resource
 * types expand eagerly, so `Product ⇄ Variant` cannot reference each other):
 * `Product` declares `variants`, and a variant points back at {@link ProductRef}
 * — a second definition of the `products` type carrying its attributes and
 * no relationships, enough for linkage (`{ type, id }`) and for the
 * `productId` filter. The node graph's `products.variants` / `variants.product`
 * pair is one edge seen from both ends (ADR-0022).
 */
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

/**
 * An attribute of the resource object — absent under a sparse fieldset,
 * required on create. (The sortable ones spell the same options inline with
 * `sort: true`: `Sort.able`'s type-level marker refuses a generic wrapper.)
 */
const attribute = <S extends Schema.String | Schema.Number>(schema: S) =>
  Resource.attribute(schema, { resource: "optional" });

/**
 * The scoping key of a private collection (ADR-0015): server-set from the
 * verified session, never a create input, filterable by `eq` — the app's
 * `myCartItems(userId)` / `myOrders(userId)` reads spell it in the URL.
 */
const scopingKey = Resource.attribute(Schema.String, {
  resource: "optional",
  create: false,
  update: false,
  filter: ["eq"],
});

export const Category = Resource.make("categories", {
  attributes: {
    name: Resource.attribute(Schema.String, { resource: "optional", sort: true }),
    slug: attribute(Schema.String),
  },
});

export const Seller = Resource.make("sellers", {
  attributes: {
    name: attribute(Schema.String),
  },
});

const productAttributes = {
  name: attribute(Schema.String),
  description: attribute(Schema.String),
  priceCents: attribute(Schema.Number),
};

/**
 * `products` as a relationship target only: the type's attributes, none of
 * its relationships, so a variant or a review can point at a product without
 * closing a cycle the library's types cannot express. {@link Product} is the
 * definition the endpoints serve.
 */
export const ProductRef = Resource.make("products", { attributes: productAttributes });

export const Variant = Resource.make("variants", {
  attributes: {
    sku: attribute(Schema.String),
    name: attribute(Schema.String),
    priceCents: attribute(Schema.Number),
    stock: attribute(Schema.Number),
  },
  relationships: {
    product: Relationship.one(() => ProductRef, { filter: ["eq", "in"] }),
  },
});

export const Product = Resource.make("products", {
  attributes: productAttributes,
  relationships: {
    category: Relationship.one(() => Category, { filter: ["eq", "in"] }),
    seller: Relationship.one(() => Seller),
    variants: Relationship.many(() => Variant),
  },
});

export const Review = Resource.make("reviews", {
  attributes: {
    // Reviews are public: the reviewer's id is served (the sync tier syncs
    // it to anonymous clients too), but is not a filter.
    userId: Resource.attribute(Schema.String, { resource: "optional", create: false, update: false }),
    authorName: attribute(Schema.String),
    rating: attribute(Schema.Number),
    body: attribute(Schema.String),
    createdAt: Resource.attribute(Schema.String, { resource: "optional", sort: true }),
  },
  relationships: {
    product: Relationship.one(() => ProductRef, { filter: ["eq", "in"] }),
  },
});

export const CartItem = Resource.make("cartItems", {
  attributes: {
    userId: scopingKey,
    qty: attribute(Schema.Number),
  },
  relationships: {
    variant: Relationship.one(() => Variant),
  },
});

export const Order = Resource.make("orders", {
  attributes: {
    userId: scopingKey,
    status: attribute(Schema.String),
    totalCents: attribute(Schema.Number),
    createdAt: Resource.attribute(Schema.String, { resource: "optional", sort: true }),
  },
});

export const OrderItem = Resource.make("orderItems", {
  attributes: {
    userId: scopingKey,
    qty: attribute(Schema.Number),
    priceCents: attribute(Schema.Number),
  },
  relationships: {
    order: Relationship.one(() => Order),
    variant: Relationship.one(() => Variant),
  },
});

/** The resources the endpoints serve, in the node graph's order. */
export const resources = [
  Category,
  Seller,
  Product,
  Variant,
  Review,
  CartItem,
  Order,
  OrderItem,
] as const;
