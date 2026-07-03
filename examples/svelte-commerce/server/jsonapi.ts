/**
 * The commerce JSON:API — endpoints and handlers.
 *
 * This is the app's naive-experience backbone (ADR-0019's out-of-band
 * writer done properly): SvelteKit loads read these endpoints, no-JS form
 * actions write through them, and every write publishes its invalidation
 * hints into the same bus that pokes live sync clients. The sync engine is
 * one more consumer of the same tables.
 *
 * Identity for user-scoped endpoints arrives as an `x-commerce-user`
 * header set by the SvelteKit process after it resolves the Better Auth
 * session — the trust boundary between the two server processes (swap for
 * a forwarded session token in a real deployment; the JSON:API itself
 * never trusts a client-supplied id, because browsers never reach it
 * directly — vite/Kit only proxy `/sync*`).
 */
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ApiError, Endpoint, Group, Handlers } from "@thomasfosterau/effect-jsonapi";
import { InvalidationBus } from "@legation/effect";
import { CartItem, Category, Order, OrderItem, Product, Review, Seller, Variant } from "./resources.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class Unauthorized extends ApiError.make<Unauthorized>()("Unauthorized", {
  status: 401,
  code: "unauthorized",
  title: "Sign in first",
}) {}

export class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
}) {}

// ─── Row → resource-object mapping ──────────────────────────────────────────

type Row = Record<string, unknown>;

const one = (type: string, id: unknown) => ({ data: { type, id: String(id) } });

const categoryResource = (row: Row): typeof Category.Type =>
  ({
  type: "categories" as const,
  id: String(row.id),
  attributes: { name: String(row.name), slug: String(row.slug) },
  }) as unknown as typeof Category.Type;

const sellerResource = (row: Row): typeof Seller.Type =>
  ({
  type: "sellers" as const,
  id: String(row.id),
  attributes: { name: String(row.name) },
  }) as unknown as typeof Seller.Type;

const variantResource = (row: Row): typeof Variant.Type =>
  ({
  type: "variants" as const,
  id: String(row.id),
  attributes: {
    productId: String(row.productId),
    sku: String(row.sku),
    name: String(row.name),
    priceCents: Number(row.priceCents),
    stock: Number(row.stock),
  },
  }) as unknown as typeof Variant.Type;

const productResource = (row: Row, variantRows: ReadonlyArray<Row>): typeof Product.Type =>
  ({
  type: "products" as const,
  id: String(row.id),
  attributes: {
    name: String(row.name),
    description: String(row.description),
    priceCents: Number(row.priceCents),
  },
  relationships: {
    category: one("categories", row.categoryId),
    seller: one("sellers", row.sellerId),
    variants: {
      data: variantRows.map((variant) => ({ type: "variants" as const, id: String(variant.id) })),
    },
  },
  }) as unknown as typeof Product.Type;

const reviewResource = (row: Row): typeof Review.Type =>
  ({
  type: "reviews" as const,
  id: String(row.id),
  attributes: {
    authorName: String(row.authorName),
    rating: Number(row.rating),
    body: String(row.body),
    createdAt: String(row.createdAt),
  },
  relationships: { product: one("products", row.productId) },
  }) as unknown as typeof Review.Type;

const cartItemResource = (row: Row): typeof CartItem.Type =>
  ({
  type: "cartItems" as const,
  id: String(row.id),
  attributes: { qty: Number(row.qty) },
  relationships: { variant: one("variants", row.variantId) },
  }) as unknown as typeof CartItem.Type;

const orderResource = (row: Row): typeof Order.Type =>
  ({
  type: "orders" as const,
  id: String(row.id),
  attributes: {
    status: String(row.status),
    totalCents: Number(row.totalCents),
    createdAt: String(row.createdAt),
  },
  }) as unknown as typeof Order.Type;

const orderItemResource = (row: Row): typeof OrderItem.Type =>
  ({
  type: "orderItems" as const,
  id: String(row.id),
  attributes: { qty: Number(row.qty), priceCents: Number(row.priceCents) },
  relationships: {
    order: one("orders", row.orderId),
    variant: one("variants", row.variantId),
  },
  }) as unknown as typeof OrderItem.Type;

// ─── API shape ───────────────────────────────────────────────────────────────

export const api = HttpApi.make("commerce")
  .add(Group.make(Category, Endpoint.list(Category)))
  .add(
    Group.make(
      Product,
      Endpoint.list(Product, {
        include: true,
        filter: { categoryId: Schema.optional(Schema.String) },
      }),
      Endpoint.get(Product, { include: true, errors: [NotFound] })
    )
  )
  .add(
    Group.make(
      Review,
      Endpoint.list(Review, { filter: { productId: Schema.String } }),
      Endpoint.create(Review, { errors: [Unauthorized] })
    )
  )
  .add(
    Group.make(
      CartItem,
      Endpoint.list(CartItem, { include: true, errors: [Unauthorized] }),
      Endpoint.create(CartItem, {
        errors: [Unauthorized, ApiError.BadRequest],
      }),
      Endpoint.delete(CartItem, { errors: [Unauthorized] })
    )
  )
  .add(
    Group.make(
      Order,
      Endpoint.list(Order, { errors: [Unauthorized] }),
      Endpoint.create(Order, {
        errors: [Unauthorized, ApiError.BadRequest],
      })
    )
  )
  .add(Group.make(OrderItem, Endpoint.list(OrderItem, { errors: [Unauthorized] })))
  .prefix("/jsonapi");

// ─── Handlers ────────────────────────────────────────────────────────────────

/** The Kit process's session verdict — see the module docs' trust note. */
const currentUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const user = request.headers["x-commerce-user"];
  return typeof user === "string" && user.length > 0 ? user : undefined;
});

const requireUser = Effect.flatMap(currentUser, (user) =>
  user === undefined ? Effect.fail(new Unauthorized()) : Effect.succeed(user)
);

const orDie = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, never, R> =>
  Effect.orDie(effect);

const hint = (collection: string, ids: ReadonlyArray<string>) => ({ collection, ids });

/** Brand plain route/form ids for typed client calls (example-level sugar). */
export const productId = (id: string): typeof Product.Type.id => id as typeof Product.Type.id;
export const cartItemId = (id: string): typeof CartItem.Type.id => id as typeof CartItem.Type.id;
export const variantId = (id: string): typeof Variant.Type.id => id as typeof Variant.Type.id;

const categoriesLive = HttpApiBuilder.group(api, "categories", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* orDie(sql`SELECT * FROM categories ORDER BY name`);
      return Handlers.collection(rows.map(categoryResource));
    })
  )
);

const productsLive = HttpApiBuilder.group(api, "products", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const categoryId = query.filter?.categoryId;
        const rows = yield* orDie(
          categoryId === undefined
            ? sql`SELECT * FROM products ORDER BY id`
            : sql`SELECT * FROM products WHERE categoryId = ${categoryId} ORDER BY id`
        );
        const ids = rows.map((row) => String(row.id));
        const variants =
          ids.length === 0
            ? []
            : yield* orDie(sql`SELECT * FROM variants WHERE productId IN ${sql.in(ids)}`);
        const byProduct = new Map<string, Array<Row>>();
        for (const variant of variants) {
          const key = String(variant.productId);
          byProduct.set(key, [...(byProduct.get(key) ?? []), variant]);
        }
        const resources = rows.map((row) =>
          productResource(row, byProduct.get(String(row.id)) ?? [])
        );
        const includeVariants = query.include?.includes("variants") ?? false;
        return Handlers.collection(resources, {
          included: includeVariants ? variants.map(variantResource) : [],
        });
      })
    )
    .handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* orDie(sql`SELECT * FROM products WHERE id = ${params.id}`);
        if (rows.length === 0) return yield* Effect.fail(new NotFound());
        const variants = yield* orDie(
          sql`SELECT * FROM variants WHERE productId = ${params.id} ORDER BY id`
        );
        const includeVariants = query.include?.includes("variants") ?? false;
        return Handlers.data(productResource(rows[0]!, variants), {
          included: includeVariants ? variants.map(variantResource) : [],
        });
      })
    )
);

const reviewsLive = HttpApiBuilder.group(api, "reviews", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* orDie(
          sql`SELECT * FROM reviews WHERE productId = ${query.filter?.productId ?? ""} ORDER BY createdAt DESC`
        );
        return Handlers.collection(rows.map(reviewResource));
      })
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const bus = yield* InvalidationBus.InvalidationBus;
        const id = `r-${crypto.randomUUID()}`;
        const { authorName, rating, body, createdAt } = payload.data.attributes;
        const productId = payload.data.relationships.product.data.id;
        yield* orDie(
          sql`INSERT INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
              VALUES (${id}, ${productId}, ${userId}, ${authorName}, ${rating}, ${body}, ${createdAt})`
        );
        yield* bus.publish([hint("reviews", [id])]);
        const rows = yield* orDie(sql`SELECT * FROM reviews WHERE id = ${id}`);
        return Handlers.data(reviewResource(rows[0]!));
      })
    )
);

const cartItemsLive = HttpApiBuilder.group(api, "cartItems", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const rows = yield* orDie(sql`SELECT * FROM cartItems WHERE userId = ${userId}`);
        const variantIds = rows.map((row) => String(row.variantId));
        const variants =
          variantIds.length === 0
            ? []
            : yield* orDie(sql`SELECT * FROM variants WHERE id IN ${sql.in(variantIds)}`);
        const includeVariants = query.include?.includes("variant") ?? false;
        return Handlers.collection(rows.map(cartItemResource), {
          included: includeVariants ? variants.map(variantResource) : [],
        });
      })
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const bus = yield* InvalidationBus.InvalidationBus;
        const variantId = payload.data.relationships.variant.data.id;
        const variant = yield* orDie(sql`SELECT stock FROM variants WHERE id = ${variantId}`);
        if (variant.length === 0) return yield* Effect.fail(new ApiError.BadRequest({}));
        const id = `ci-${crypto.randomUUID()}`;
        yield* orDie(
          sql`INSERT INTO cartItems (id, userId, variantId, qty)
              VALUES (${id}, ${userId}, ${variantId}, ${payload.data.attributes.qty})`
        );
        yield* bus.publish([hint("cartItems", [id])]);
        const rows = yield* orDie(sql`SELECT * FROM cartItems WHERE id = ${id}`);
        return Handlers.data(cartItemResource(rows[0]!));
      })
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const bus = yield* InvalidationBus.InvalidationBus;
        yield* orDie(sql`DELETE FROM cartItems WHERE id = ${params.id} AND userId = ${userId}`);
        yield* bus.publish([hint("cartItems", [params.id])]);
      })
    )
);

const ordersLive = HttpApiBuilder.group(api, "orders", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const rows = yield* orDie(
          sql`SELECT * FROM orders WHERE userId = ${userId} ORDER BY createdAt DESC`
        );
        return Handlers.collection(rows.map(orderResource));
      })
    )
    // Order placement: recomputed from the authoritative cart, exactly like
    // the sync mutator's server half — the client's payload only carries the
    // metadata (createdAt); items/total/stock all derive server-side.
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const bus = yield* InvalidationBus.InvalidationBus;
        const orderId = `o-${crypto.randomUUID()}`;
        const createdAt = payload.data.attributes.createdAt;
        const result = yield* orDie(
          sql.withTransaction(
            Effect.gen(function* () {
              const cart = yield* sql<{
                id: string;
                variantId: string;
                qty: number;
                priceCents: number;
                stock: number;
              }>`SELECT c.id, c.variantId, c.qty, v.priceCents, v.stock
                 FROM cartItems c JOIN variants v ON v.id = c.variantId
                 WHERE c.userId = ${userId}`;
              if (cart.length === 0 || cart.some((line) => line.stock < line.qty)) {
                return undefined;
              }
              const total = cart.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
              yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
                VALUES (${orderId}, ${userId}, 'placed', ${total}, ${createdAt})`;
              const itemIds: Array<string> = [];
              for (const [index, line] of cart.entries()) {
                const itemId = `${orderId}-${index}`;
                itemIds.push(itemId);
                yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
                  VALUES (${itemId}, ${orderId}, ${userId}, ${line.variantId}, ${line.qty}, ${line.priceCents})`;
                yield* sql`UPDATE variants SET stock = stock - ${line.qty} WHERE id = ${line.variantId}`;
              }
              yield* sql`DELETE FROM cartItems WHERE userId = ${userId}`;
              return { itemIds, cartIds: cart.map((line) => line.id), variantIds: cart.map((line) => line.variantId) };
            })
          )
        );
        if (result === undefined) return yield* Effect.fail(new ApiError.BadRequest({}));
        yield* bus.publish([
          hint("orders", [orderId]),
          hint("orderItems", result.itemIds),
          hint("cartItems", result.cartIds),
          hint("variants", result.variantIds),
        ]);
        const rows = yield* orDie(sql`SELECT * FROM orders WHERE id = ${orderId}`);
        return Handlers.data(orderResource(rows[0]!));
      })
    )
);

const orderItemsLive = HttpApiBuilder.group(api, "orderItems", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const userId = yield* requireUser;
      const sql = yield* SqlClient;
      const rows = yield* orDie(sql`SELECT * FROM orderItems WHERE userId = ${userId}`);
      return Handlers.collection(rows.map(orderItemResource));
    })
  )
);

/** Registers the JSON:API's routes on the ambient `HttpRouter`. */
export const jsonApiLive = HttpApiBuilder.layer(api).pipe(
  Layer.provide(categoriesLive),
  Layer.provide(productsLive),
  Layer.provide(reviewsLive),
  Layer.provide(cartItemsLive),
  Layer.provide(ordersLive),
  Layer.provide(orderItemsLive)
);
