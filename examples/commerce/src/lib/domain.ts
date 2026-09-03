/**
 * Shared domain — the node graph, reads, mutators
 *
 * One module, imported by both sides: the SvelteKit app (optimistic client
 * mutators, reads for pages) and the Effect server (schemas for validating
 * pushed args; the authoritative SQL handlers live in `server/handlers.ts`).
 * Mutators are defined once and executed twice (ADR-0008) — the client
 * handlers here write the optimistic overlay, the server handlers write SQL.
 *
 * The graph is declared as **Nodes and Edges** (ADR-0022): each foreign key
 * is declared exactly once, on the child (`Edge.one(..., { via })`), and the
 * parent names the inverse — the engine registry, the joins, the sync
 * windows, and the fan-out topics all derive from the same declarations
 * (the old hand-written both-directions `Collection.relationships` are
 * gone). `reviews` is a **paginated** edge: its order is part of the edge's
 * identity, and a windowed include syncs per-parent windows (ADR-0024).
 *
 * Public catalog collections (products, variants, categories, sellers,
 * reviews) are readable by anyone; private collections (profiles, cartItems,
 * orders, orderItems) carry a `userId` the auth filters scope by
 * (ADR-0015's denormalized key) — declared as `hintKeys`, so ADR-0023's
 * fine fan-out topics can use the same field.
 *
 * Each node also declares its **filterable set** (ADR-0028, #154): exactly
 * the fields the reads below filter and order by. `id` and every one-edge
 * key are `eq`/`in` by default; `userId` (a scoping key, not an edge) and
 * the sort fields are declared explicitly. Anything else is unreachable
 * from a client.
 */
import { Effect, Schema } from "effect";
import { Edge, Mutation, Node, type Query } from "@legation/effect";

// ─── Row schemas ─────────────────────────────────────────────────────────────

export const CategorySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
export type Category = typeof CategorySchema.Type;

export const SellerSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type Seller = typeof SellerSchema.Type;

export const ProductSchema = Schema.Struct({
  id: Schema.String,
  categoryId: Schema.String,
  sellerId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  priceCents: Schema.Number,
});
export type Product = typeof ProductSchema.Type;

export const VariantSchema = Schema.Struct({
  id: Schema.String,
  productId: Schema.String,
  sku: Schema.String,
  name: Schema.String,
  priceCents: Schema.Number,
  stock: Schema.Number,
});
export type Variant = typeof VariantSchema.Type;

export const ReviewSchema = Schema.Struct({
  id: Schema.String,
  productId: Schema.String,
  userId: Schema.String,
  authorName: Schema.String,
  rating: Schema.Number,
  body: Schema.String,
  createdAt: Schema.String,
});
export type Review = typeof ReviewSchema.Type;

export const ProfileSchema = Schema.Struct({
  id: Schema.String, // = userId
  name: Schema.String,
});
export type Profile = typeof ProfileSchema.Type;

export const CartItemSchema = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  variantId: Schema.String,
  qty: Schema.Number,
});
export type CartItem = typeof CartItemSchema.Type;

export const OrderSchema = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  status: Schema.Literals(["placed", "shipped", "delivered"]),
  totalCents: Schema.Number,
  createdAt: Schema.String,
});
export type Order = typeof OrderSchema.Type;

export const OrderItemSchema = Schema.Struct({
  id: Schema.String,
  orderId: Schema.String,
  userId: Schema.String, // denormalized scoping key (ADR-0015)
  variantId: Schema.String,
  qty: Schema.Number,
  priceCents: Schema.Number,
});
export type OrderItem = typeof OrderItemSchema.Type;

// ─── The node graph (ADR-0022: declare each key once, name both directions) ──

const { id: _categoryId, ...categoryAttributes } = CategorySchema.fields;
const { id: _sellerId, ...sellerAttributes } = SellerSchema.fields;
const {
  id: _productId,
  categoryId: _productCategoryId,
  sellerId: _productSellerId,
  ...productAttributes
} = ProductSchema.fields;
const { id: _variantId, productId: _variantProductId, ...variantAttributes } = VariantSchema.fields;
const { id: _reviewId, productId: _reviewProductId, ...reviewAttributes } = ReviewSchema.fields;
const { id: _profileId, ...profileAttributes } = ProfileSchema.fields;
const { id: _cartItemId, variantId: _cartVariantId, ...cartItemAttributes } = CartItemSchema.fields;
const { id: _orderId, ...orderAttributes } = OrderSchema.fields;
const {
  id: _orderItemId,
  orderId: _itemOrderId,
  variantId: _itemVariantId,
  ...orderItemAttributes
} = OrderItemSchema.fields;

export const categories = Node.make("categories", {
  attributes: categoryAttributes,
  sortable: ["name"],
});

export const sellers = Node.make("sellers", { attributes: sellerAttributes });

export const products = Node.make("products", {
  attributes: productAttributes,
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    seller: Edge.one("sellers", { via: "sellerId" }),
    variants: Edge.many("variants", { inverse: "product" }),
    // Order is part of the edge's identity (cursor windows need it) — the
    // newest-first review feed is declared here, not per query.
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
});

export const variants = Node.make("variants", {
  attributes: variantAttributes,
  edges: { product: Edge.one("products", { via: "productId" }) },
});

export const reviews = Node.make("reviews", {
  attributes: reviewAttributes,
  edges: { product: Edge.one("products", { via: "productId" }) },
  hintKeys: ["userId"],
  // `productReviews` reads the collection directly, newest first. (The
  // paginated `reviews` edge's order joins `sortable` on its own when the
  // graph closes; this declaration covers the direct read.)
  sortable: ["createdAt"],
});

export const profiles = Node.make("profiles", { attributes: profileAttributes });

export const cartItems = Node.make("cartItems", {
  attributes: cartItemAttributes,
  edges: { variant: Edge.one("variants", { via: "variantId" }) },
  hintKeys: ["userId"],
  filterable: { userId: ["eq"] },
});

export const orders = Node.make("orders", {
  attributes: orderAttributes,
  edges: { items: Edge.many("orderItems", { inverse: "order" }) },
  hintKeys: ["userId"],
  filterable: { userId: ["eq"] },
  sortable: ["createdAt"],
});

export const orderItems = Node.make("orderItems", {
  attributes: orderItemAttributes,
  edges: {
    order: Edge.one("orders", { via: "orderId" }),
    variant: Edge.one("variants", { via: "variantId" }),
  },
  hintKeys: ["userId"],
  filterable: { userId: ["eq"] },
});

/** The closed, validated graph: nodes + the derived engine registry. */
export const nodes = Node.registry([
  categories,
  sellers,
  products,
  variants,
  reviews,
  profiles,
  cartItems,
  orders,
  orderItems,
]);

/** The engine's collection registry, derived edge-for-edge from the graph. */
export const registry = nodes.collections;

/** Names of the public catalog collections (auth: allow all). */
export const publicCollections = ["categories", "sellers", "products", "variants", "reviews"] as const;
/** Names of the private, identity-scoped collections. */
export const privateCollections = ["profiles", "cartItems", "orders", "orderItems"] as const;

// ─── Reads ───────────────────────────────────────────────────────────────────
//
// Declarative reads (Query.Read) are the app's whole read vocabulary: the
// rune hooks pass them to the Client, which compiles the plan, registers
// the windows, and decides where each read is answered.

export const allCategories: Query.Read = { collection: "categories", order: ["name"] };
export const allSellers: Query.Read = { collection: "sellers" };
export const allVariants: Query.Read = { collection: "variants" };
export const allReviews: Query.Read = { collection: "reviews" };

/**
 * One product with its detail-page edges resolved. Reviews are NOT included
 * here — the detail page pages them with a `useConnection` over
 * {@link productReviews}, so the window (not the whole feed) is what syncs.
 */
export const productDetail = (id: string): Query.Read => ({
  collection: "products",
  where: { id },
  include: { variants: true, seller: true },
});

/** One catalog page: ordered by id, cursor + limit windowed. */
export const productPage = (options: {
  categoryId?: string;
  cursor?: string;
  limit?: number;
}): Query.Read => ({
  collection: "products",
  ...(options.categoryId !== undefined ? { where: { categoryId: options.categoryId } } : {}),
  order: ["id"],
  first: options.limit ?? 12,
  ...(options.cursor !== undefined ? { after: options.cursor } : {}),
});

export const productReviews = (productId: string): Query.Read => ({
  collection: "reviews",
  where: { productId },
  order: ["-createdAt"],
});

export const myCartItems = (userId: string): Query.Read => ({
  collection: "cartItems",
  where: { userId },
  include: { variant: true },
});

export const myOrders = (userId: string): Query.Read => ({
  collection: "orders",
  where: { userId },
  order: ["-createdAt"],
});

export const myOrderItems = (userId: string): Query.Read => ({
  collection: "orderItems",
  where: { userId },
});

export const myProfile = (userId: string): Query.Read => ({
  collection: "profiles",
  where: { id: userId },
});

/**
 * Everything the app shell keeps live — the reads the tab's Client pins at
 * boot (subscriptions are client state, refcounted per mirror by the host).
 */
export const shellReads = (userId: string | undefined): ReadonlyArray<Query.Read> => [
  { collection: "products", order: ["id"], first: 100 },
  allCategories,
  allSellers,
  allVariants,
  allReviews,
  ...(userId === undefined
    ? []
    : [myCartItems(userId), myOrders(userId), myOrderItems(userId), myProfile(userId)]),
];

// ─── Mutators (client-optimistic handlers; SQL handlers on the server) ──────

export const CartAddArgs = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  variantId: Schema.String,
  qty: Schema.Number,
});
export type CartAdd = typeof CartAddArgs.Type;

export const CartSetQtyArgs = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  qty: Schema.Number,
});
export type CartSetQty = typeof CartSetQtyArgs.Type;

export const CartRemoveArgs = Schema.Struct({ id: Schema.String, userId: Schema.String });
export type CartRemove = typeof CartRemoveArgs.Type;

/**
 * `items` is the client's snapshot of its cart at call time — it drives the
 * optimistic overlay only. The server recomputes the order from its
 * authoritative cart inside the push transaction, so a cart that changed on
 * another device between journal and push still produces a correct order
 * (conflict resolution is replay, ADR-0008).
 */
export const OrderPlaceArgs = Schema.Struct({
  orderId: Schema.String,
  userId: Schema.String,
  createdAt: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      cartItemId: Schema.String,
      variantId: Schema.String,
      qty: Schema.Number,
      priceCents: Schema.Number,
    })
  ),
});
export type OrderPlace = typeof OrderPlaceArgs.Type;

export const ReviewWriteArgs = ReviewSchema;
export const ProfileUpdateArgs = ProfileSchema;

export const mutators = Mutation.registry([
  {
    mutator: Mutation.make("cart/add", CartAddArgs),
    local: (args, writer) =>
      writer.put("cartItems", args.id, {
        id: args.id,
        userId: args.userId,
        variantId: args.variantId,
        qty: args.qty,
      } satisfies CartItem),
  },
  {
    mutator: Mutation.make("cart/setQty", CartSetQtyArgs),
    // Re-runnable on every rebase: read the current row, write the new qty.
    local: (args, writer) =>
      Effect.flatMap(writer.get("cartItems", args.id), (current) =>
        current === undefined
          ? Effect.void
          : writer.put("cartItems", args.id, { ...(current as CartItem), qty: args.qty })
      ),
  },
  {
    mutator: Mutation.make("cart/remove", CartRemoveArgs),
    local: (args, writer) => writer.del("cartItems", args.id),
  },
  {
    mutator: Mutation.make("order/place", OrderPlaceArgs),
    local: (args, writer) =>
      Effect.gen(function* () {
        const total = args.items.reduce((sum: number, item: { priceCents: number; qty: number }) => sum + item.priceCents * item.qty, 0);
        yield* writer.put("orders", args.orderId, {
          id: args.orderId,
          userId: args.userId,
          status: "placed",
          totalCents: total,
          createdAt: args.createdAt,
        } satisfies Order);
        for (const [index, item] of args.items.entries()) {
          yield* writer.put("orderItems", `${args.orderId}-${index}`, {
            id: `${args.orderId}-${index}`,
            orderId: args.orderId,
            userId: args.userId,
            variantId: item.variantId,
            qty: item.qty,
            priceCents: item.priceCents,
          } satisfies OrderItem);
          yield* writer.del("cartItems", item.cartItemId);
        }
      }),
  },
  {
    mutator: Mutation.make("review/write", ReviewWriteArgs),
    local: (args, writer) => writer.put("reviews", args.id, args),
  },
  {
    mutator: Mutation.make("profile/update", ProfileUpdateArgs),
    local: (args, writer) => writer.put("profiles", args.id, args),
  },
]);
