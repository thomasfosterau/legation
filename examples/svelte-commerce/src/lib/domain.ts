/**
 * Shared domain — collections, subsets, mutators
 *
 * One module, imported by both sides: the SvelteKit app (optimistic client
 * mutators, typed subsets for pages) and the Effect server (schemas for
 * validating pushed args; the authoritative SQL handlers live in
 * `server/handlers.ts`). Mutators are defined once and executed twice
 * (ADR-0008) — the client handlers here write the optimistic overlay, the
 * server handlers write SQL.
 *
 * Public catalog collections (products, variants, categories, sellers,
 * reviews) are readable by anyone; private collections (profiles, cartItems,
 * orders, orderItems) carry a `userId` the auth filters scope by
 * (ADR-0015's denormalized key).
 */
import { Effect, Schema } from "effect";
import { Collection, Mutator, Subset } from "@legation/effect";

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

// ─── Collections (with declared relationships) ──────────────────────────────

export const categories = Collection.make({
  name: "categories",
  schema: CategorySchema,
  id: (row) => row.id,
});

export const sellers = Collection.make({
  name: "sellers",
  schema: SellerSchema,
  id: (row) => row.id,
});

export const products = Collection.make({
  name: "products",
  schema: ProductSchema,
  id: (row) => row.id,
  relationships: [
    { name: "category", kind: "one", collection: "categories", localField: "categoryId", foreignField: "id" },
    { name: "seller", kind: "one", collection: "sellers", localField: "sellerId", foreignField: "id" },
    { name: "variants", kind: "many", collection: "variants", localField: "id", foreignField: "productId" },
    { name: "reviews", kind: "many", collection: "reviews", localField: "id", foreignField: "productId" },
  ],
});

export const variants = Collection.make({
  name: "variants",
  schema: VariantSchema,
  id: (row) => row.id,
  relationships: [
    { name: "product", kind: "one", collection: "products", localField: "productId", foreignField: "id" },
  ],
});

export const reviews = Collection.make({
  name: "reviews",
  schema: ReviewSchema,
  id: (row) => row.id,
});

export const profiles = Collection.make({
  name: "profiles",
  schema: ProfileSchema,
  id: (row) => row.id,
});

export const cartItems = Collection.make({
  name: "cartItems",
  schema: CartItemSchema,
  id: (row) => row.id,
  relationships: [
    { name: "variant", kind: "one", collection: "variants", localField: "variantId", foreignField: "id" },
  ],
});

export const orders = Collection.make({
  name: "orders",
  schema: OrderSchema,
  id: (row) => row.id,
  relationships: [
    { name: "items", kind: "many", collection: "orderItems", localField: "id", foreignField: "orderId" },
  ],
});

export const orderItems = Collection.make({
  name: "orderItems",
  schema: OrderItemSchema,
  id: (row) => row.id,
  relationships: [
    { name: "variant", kind: "one", collection: "variants", localField: "variantId", foreignField: "id" },
  ],
});

export const registry = Collection.registry([
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

/** Names of the public catalog collections (auth: allow all). */
export const publicCollections = ["categories", "sellers", "products", "variants", "reviews"] as const;
/** Names of the private, identity-scoped collections. */
export const privateCollections = ["profiles", "cartItems", "orders", "orderItems"] as const;

// ─── Subsets ─────────────────────────────────────────────────────────────────

export const Products = Subset.for(products);
export const Variants = Subset.for(variants);
export const Categories = Subset.for(categories);
export const Sellers = Subset.for(sellers);
export const Reviews = Subset.for(reviews);
export const CartItems = Subset.for(cartItems);
export const Orders = Subset.for(orders);
export const OrderItems = Subset.for(orderItems);
export const Profiles = Subset.for(profiles);

export const allCategories = Categories.make({ orderBy: [{ field: "name", direction: "asc" }] });
export const allSellers = Sellers.make({});
export const allVariants = Variants.make({});
export const allReviews = Reviews.make({});

/** One catalog page: ordered by id, cursor + limit windowed (Subset.window). */
export const productPage = (options: { categoryId?: string; cursor?: string; limit?: number }) =>
  Products.make({
    ...(options.categoryId !== undefined
      ? { where: (p) => p.eq("categoryId", options.categoryId!) }
      : {}),
    orderBy: [{ field: "id", direction: "asc" }],
    limit: options.limit ?? 12,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  });

export const productReviews = (productId: string) =>
  Reviews.make({
    where: (p) => p.eq("productId", productId),
    orderBy: [{ field: "createdAt", direction: "desc" }],
  });

export const myCartItems = (userId: string) =>
  CartItems.make({ where: (p) => p.eq("userId", userId) });

export const myOrders = (userId: string) =>
  Orders.make({
    where: (p) => p.eq("userId", userId),
    orderBy: [{ field: "createdAt", direction: "desc" }],
  });

export const myOrderItems = (userId: string) =>
  OrderItems.make({ where: (p) => p.eq("userId", userId) });

export const myProfile = (userId: string) => Profiles.make({ where: (p) => p.eq("id", userId) });

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

export const mutators = Mutator.registry([
  {
    mutator: Mutator.make("cart/add", CartAddArgs),
    local: (args, writer) =>
      writer.put("cartItems", args.id, {
        id: args.id,
        userId: args.userId,
        variantId: args.variantId,
        qty: args.qty,
      } satisfies CartItem),
  },
  {
    mutator: Mutator.make("cart/setQty", CartSetQtyArgs),
    // Re-runnable on every rebase: read the current row, write the new qty.
    local: (args, writer) =>
      Effect.flatMap(writer.get("cartItems", args.id), (current) =>
        current === undefined
          ? Effect.void
          : writer.put("cartItems", args.id, { ...(current as CartItem), qty: args.qty })
      ),
  },
  {
    mutator: Mutator.make("cart/remove", CartRemoveArgs),
    local: (args, writer) => writer.del("cartItems", args.id),
  },
  {
    mutator: Mutator.make("order/place", OrderPlaceArgs),
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
    mutator: Mutator.make("review/write", ReviewWriteArgs),
    local: (args, writer) => writer.put("reviews", args.id, args),
  },
  {
    mutator: Mutator.make("profile/update", ProfileUpdateArgs),
    local: (args, writer) => writer.put("profiles", args.id, args),
  },
]);
