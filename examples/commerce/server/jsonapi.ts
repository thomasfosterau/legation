/**
 * The commerce JSON:API — endpoints and handlers.
 *
 * This is the app's naive-experience backbone (ADR-0019's out-of-band
 * writer done properly): SvelteKit loads read these endpoints, no-JS form
 * actions write through them, and every write publishes its invalidation
 * hints into the same bus that pokes live sync clients. The sync engine is
 * one more consumer of the same tables.
 *
 * **Reads are derived, writes are hand-written.** Every `list` / `get` is
 * `RestHandlers` (#163) over the app's node graph, backend and auth policy:
 * the URL is the filter grammar (ADR-0028) — `filter[categoryId]=c-audio`,
 * `filter[userId]=u1`, `sort=-createdAt`, `page[limit]=4&page[after]=p-04`,
 * `include=variants`, `fields[products]=name` — parsed once into a
 * `Query.Read`, run through the same `Query.plan` → `authorize` →
 * `SqlBackend.evaluate` path the sync tier's pulls take, and serialised by
 * `DocumentWriter`. No `WHERE userId` lives here: a private collection is
 * scoped by the policy's identity filter (an anonymous request sees the
 * empty allow-set — an empty collection, or a 404 for a `get`), and a URL
 * the grammar rejects is a 400 error document with `source.parameter`. Each
 * endpoint declares its query as the graph's own codec
 * (`JsonApiQuery.querySchema` for a `list`, `singleRowSchema` for a `get`),
 * so the contract the api publishes is the grammar the handler parses. The
 * writes keep their SQL and their `broadcast`: they are the mutators'
 * out-of-band twins.
 *
 * The api's shape — endpoints and wire errors — lives in `server/api.ts`,
 * which the service worker also loads to reflect the read routes for the
 * façade (ADR-0029): this module binds the handlers to it and re-exports it.
 *
 * Identity for user-scoped endpoints arrives as an `x-commerce-user`
 * header set by the SvelteKit process after it resolves the Better Auth
 * session — the trust boundary between the two server processes (swap for
 * a forwarded session token in a real deployment; the JSON:API itself
 * never trusts a client-supplied id, because browsers never reach it
 * directly — vite/Kit only proxy `/sync*`, and the browser's own JSON:API
 * reads go through the Kit read proxy, `src/routes/jsonapi/[...path]/+server.ts`,
 * which sets this header from the session and drops the client's).
 */
import { Context, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpServerRequest as Request } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ApiError, Handlers, Middleware } from "@thomasfosterau/effect-jsonapi";
import type { Backend } from "@legation/effect";
import { RestHandlers } from "@legation/jsonapi";
import { nodes } from "../src/lib/domain.js";
import { api, NotFound, Unauthorized } from "./api.js";
import { CartItem, Category, Order, OrderItem, Product, Review, Variant } from "./resources.js";
import { authPolicy, CommerceSync } from "./runtime.js";

export { api, NotFound, Unauthorized } from "./api.js";

// ─── Row → resource-object mapping (the writes' responses) ──────────────────
//
// Rows come from our own SQL; each mapper constructs the resource with the
// library's branded id constructors (`X.Id.make`), so the objects satisfy
// `typeof X.Type` structurally — no casts. The reads never come through
// here: the derivation writes their documents from the node graph.

type Row = Record<string, unknown>;

const reviewResource = (row: Row): typeof Review.Type => ({
  type: "reviews",
  id: Review.Id.make(String(row.id)),
  attributes: {
    userId: String(row.userId),
    authorName: String(row.authorName),
    rating: Number(row.rating),
    body: String(row.body),
    createdAt: String(row.createdAt),
  },
  relationships: {
    product: { data: { type: "products", id: Product.Id.make(String(row.productId)) } },
  },
});

const cartItemResource = (row: Row): typeof CartItem.Type => ({
  type: "cartItems",
  id: CartItem.Id.make(String(row.id)),
  attributes: { userId: String(row.userId), qty: Number(row.qty) },
  relationships: {
    variant: { data: { type: "variants", id: Variant.Id.make(String(row.variantId)) } },
  },
});

const orderResource = (row: Row): typeof Order.Type => ({
  type: "orders",
  id: Order.Id.make(String(row.id)),
  attributes: {
    userId: String(row.userId),
    status: String(row.status),
    totalCents: Number(row.totalCents),
    createdAt: String(row.createdAt),
  },
});

// ─── Identity ────────────────────────────────────────────────────────────────

/** The Kit process's session verdict — see the module docs' trust note. */
const userOf = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const user = request.headers["x-commerce-user"];
  return typeof user === "string" && user.length > 0 ? user : undefined;
};

const currentUser = Effect.map(Request.HttpServerRequest, userOf);

const requireUser = Effect.flatMap(currentUser, (user) =>
  user === undefined ? Effect.fail(new Unauthorized()) : Effect.succeed(user)
);

/**
 * The derived reads' identity seam: the same header, as the `SyncContext`
 * the auth filters see — `identity` present iff the Kit process vouched for
 * a user, exactly what the `IdentityResolver` gives the sync tier.
 */
const restContext = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<Backend.SyncContext> => {
  const user = userOf(request);
  return Effect.succeed({
    clientGroupId: "http",
    ...(user === undefined ? {} : { identity: user }),
  });
};

// ─── Derived reads ───────────────────────────────────────────────────────────

/**
 * The read handlers, bound to the app's graph, the Server's backend and its
 * auth policy — the same three the sync tier evaluates through, so
 * `GET /jsonapi/products?filter[categoryId]=c-audio` and a subscription to
 * `productPage({ categoryId: "c-audio" })` are one read (ADR-0029 §6).
 * A service, built once and shared by every group.
 */
const Rest = Context.Service<RestHandlers.RestHandlers>("commerce/RestHandlers");

const restLive: Layer.Layer<RestHandlers.RestHandlers, never, CommerceSync> = Layer.effect(Rest)(
  Effect.map(CommerceSync, ({ backend }) =>
    RestHandlers.make({
      nodes,
      backend,
      policy: authPolicy,
      context: restContext,
      prefix: "/jsonapi",
    })
  )
);

const notFound = { notFound: () => new NotFound() };

// ─── Handlers ────────────────────────────────────────────────────────────────

const orDie = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, never, R> =>
  Effect.orDie(effect);

/**
 * The write handlers write SQL directly, bypassing the sync protocol's push
 * path — so they announce the change themselves. `broadcast` is ADR-0022's
 * single verb for exactly that: subscribers whose windows may be affected
 * are poked and pull.
 */
const broadcast = (collection: string, ids: ReadonlyArray<string>) =>
  Effect.flatMap(CommerceSync, (sync) => sync.server.broadcast({ collection, ids }));

/** Brand plain route/form ids for typed client calls (example-level sugar). */
export const productId = Product.Id.make;
export const cartItemId = CartItem.Id.make;
export const variantId = Variant.Id.make;

const categoriesLive = HttpApiBuilder.group(api, "categories", (handlers) =>
  Effect.map(Rest, (rest) => handlers.handle("list", rest.list(Category)))
);

const productsLive = HttpApiBuilder.group(api, "products", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers.handle("list", rest.list(Product)).handle("get", rest.get(Product, notFound))
  )
);

const variantsLive = HttpApiBuilder.group(api, "variants", (handlers) =>
  Effect.map(Rest, (rest) => handlers.handle("list", rest.list(Variant)))
);

const reviewsLive = HttpApiBuilder.group(api, "reviews", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers.handle("list", rest.list(Review)).handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const id = `r-${crypto.randomUUID()}`;
        const { authorName, rating, body, createdAt } = payload.data.attributes;
        const productId = payload.data.relationships.product.data.id;
        yield* orDie(
          sql`INSERT INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
              VALUES (${id}, ${productId}, ${userId}, ${authorName}, ${rating}, ${body}, ${createdAt})`
        );
        yield* broadcast("reviews", [id]);
        const rows = yield* orDie(sql`SELECT * FROM reviews WHERE id = ${id}`);
        return Handlers.data(reviewResource(rows[0]!));
      })
    )
  )
);

const cartItemsLive = HttpApiBuilder.group(api, "cartItems", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers
      .handle("list", rest.list(CartItem))
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
          const variantId = payload.data.relationships.variant.data.id;
          const variant = yield* orDie(sql`SELECT stock FROM variants WHERE id = ${variantId}`);
          if (variant.length === 0) return yield* Effect.fail(new ApiError.BadRequest({}));
          const id = `ci-${crypto.randomUUID()}`;
          yield* orDie(
            sql`INSERT INTO cartItems (id, userId, variantId, qty)
                VALUES (${id}, ${userId}, ${variantId}, ${payload.data.attributes.qty})`
          );
          yield* broadcast("cartItems", [id]);
          const rows = yield* orDie(sql`SELECT * FROM cartItems WHERE id = ${id}`);
          return Handlers.data(cartItemResource(rows[0]!));
        })
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
          yield* orDie(sql`DELETE FROM cartItems WHERE id = ${params.id} AND userId = ${userId}`);
          yield* broadcast("cartItems", [params.id]);
        })
      )
  )
);

const ordersLive = HttpApiBuilder.group(api, "orders", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers
      .handle("list", rest.list(Order))
      // Order placement: recomputed from the authoritative cart, exactly like
      // the sync mutator's server half — the client's payload only carries the
      // metadata (createdAt); items/total/stock all derive server-side.
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
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
                return {
                  itemIds,
                  cartIds: cart.map((line) => line.id),
                  variantIds: cart.map((line) => line.variantId),
                };
              })
            )
          );
          if (result === undefined) return yield* Effect.fail(new ApiError.BadRequest({}));
          yield* broadcast("orders", [orderId]);
          yield* broadcast("orderItems", result.itemIds);
          yield* broadcast("cartItems", result.cartIds);
          yield* broadcast("variants", result.variantIds);
          const rows = yield* orDie(sql`SELECT * FROM orders WHERE id = ${orderId}`);
          return Handlers.data(orderResource(rows[0]!));
        })
      )
  )
);

const orderItemsLive = HttpApiBuilder.group(api, "orderItems", (handlers) =>
  Effect.map(Rest, (rest) => handlers.handle("list", rest.list(OrderItem)))
);

/** Registers the JSON:API's routes on the ambient `HttpRouter`. */
export const jsonApiLive = HttpApiBuilder.layer(api).pipe(
  Layer.provide(
    Layer.mergeAll(
      categoriesLive,
      productsLive,
      variantsLive,
      reviewsLive,
      cartItemsLive,
      ordersLive,
      orderItemsLive
    ).pipe(Layer.provide(Middleware.layer), Layer.provide(restLive))
  ),
  Layer.provide(Middleware.layer)
);
