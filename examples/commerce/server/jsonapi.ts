/**
 * The commerce JSON:API — endpoints and handlers.
 *
 * This is the app's naive-experience backbone (ADR-0019's out-of-band
 * writer done properly): SvelteKit loads read these endpoints, no-JS form
 * actions write through them, and every write publishes its invalidation
 * hints into the same bus that pokes live sync clients. The sync engine is
 * one more consumer of the same tables.
 *
 * The `operations` group is the JSON:API Atomic Operations extension over
 * the same rules: one request carrying an ordered batch of `add` / `update`
 * / `remove` operations on reviews, cart items and orders, applied inside one
 * SQL transaction — the first failure rolls the whole batch back and names
 * the failing operation. `@legation/jsonapi`'s `JsonApiBackend` pushes its
 * journal through it as one request per batch when the api advertises it.
 *
 * Identity for user-scoped endpoints arrives as an `x-commerce-user`
 * header set by the SvelteKit process after it resolves the Better Auth
 * session — the trust boundary between the two server processes (swap for
 * a forwarded session token in a real deployment; the JSON:API itself
 * never trusts a client-supplied id, because browsers never reach it
 * directly — vite/Kit only proxy `/sync*`).
 */
import { Data, Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ApiError,
  Atomic,
  Document,
  Endpoint,
  Group,
  Handlers,
  Lid,
  Middleware,
} from "@thomasfosterau/effect-jsonapi";
import { CartItem, Category, Order, OrderItem, Product, Review, Seller, Variant } from "./resources.js";
import { CommerceSync } from "./runtime.js";

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

/**
 * One operation's failure inside an atomic batch — the in-handler form. The
 * extension wants the error document to name the failing operation through
 * `source.pointer`; `ApiError.make` carries custom fields under `meta`, not
 * `source`, so the wire shape is declared structurally below (any
 * `{ status, wire }` is an `ErrorClass`) and this class is what the batch
 * logic fails with. `detail` doubles as the rejection reason a pushing
 * `JsonApiBackend` records, so it mirrors the sync mutators' reasons.
 */
class OperationFailed extends Data.TaggedError("OperationFailed")<{
  readonly status: 401 | 404 | 409 | 422;
  readonly index: number;
  readonly title: string;
  readonly detail: string;
}> {}

/**
 * A JSON:API error document at `status`, discriminated inside the endpoint's
 * error union by the error object's `status` literal (the same trick
 * `ApiError`'s own wire schemas use), so the three statuses below encode to
 * the right response even though their documents are otherwise alike.
 */
const operationErrorWire = (status: number) =>
  Document.ErrorDocument(
    Schema.Struct({ ...Document.ErrorObject.fields, status: Schema.Literals([String(status)]) })
  ).pipe(
    HttpApiSchema.asJson({ contentType: "application/vnd.api+json" }),
    HttpApiSchema.status(status)
  );

/** No identity for an operation that needs one. */
export const OperationUnauthorized = { status: 401, wire: operationErrorWire(401) } as const;
/** The operation's target row does not exist (or is not the caller's). */
export const OperationNotFound = { status: 404, wire: operationErrorWire(404) } as const;
/** A client-generated id on `add` that names another user's row. */
export const OperationConflict = { status: 409, wire: operationErrorWire(409) } as const;
/** A business rule refused the operation (stock, rating, unsupported op). */
export const OperationRejected = { status: 422, wire: operationErrorWire(422) } as const;

type OperationFailureDocument = (typeof OperationRejected.wire)["Type"];

const failureDocument = (failure: OperationFailed): OperationFailureDocument => ({
  errors: [
    {
      status: String(failure.status),
      title: failure.title,
      detail: failure.detail,
      source: { pointer: Atomic.operationPointer(failure.index) },
    },
  ],
});

// ─── Row → resource-object mapping ──────────────────────────────────────────
//
// Rows come from our own SQL; each mapper constructs the resource with the
// library's branded id constructors (`X.Id.make`), so the objects satisfy
// `typeof X.Type` structurally — no casts.

type Row = Record<string, unknown>;

const categoryResource = (row: Row): typeof Category.Type => ({
  type: "categories",
  id: Category.Id.make(String(row.id)),
  attributes: { name: String(row.name), slug: String(row.slug) },
});

const sellerResource = (row: Row): typeof Seller.Type => ({
  type: "sellers",
  id: Seller.Id.make(String(row.id)),
  attributes: { name: String(row.name) },
});

const variantResource = (row: Row): typeof Variant.Type => ({
  type: "variants",
  id: Variant.Id.make(String(row.id)),
  attributes: {
    productId: String(row.productId),
    sku: String(row.sku),
    name: String(row.name),
    priceCents: Number(row.priceCents),
    stock: Number(row.stock),
  },
});

const productResource = (row: Row, variantRows: ReadonlyArray<Row>): typeof Product.Type => ({
  type: "products",
  id: Product.Id.make(String(row.id)),
  attributes: {
    name: String(row.name),
    description: String(row.description),
    priceCents: Number(row.priceCents),
  },
  relationships: {
    category: { data: { type: "categories", id: Category.Id.make(String(row.categoryId)) } },
    seller: { data: { type: "sellers", id: Seller.Id.make(String(row.sellerId)) } },
    variants: {
      data: variantRows.map((variant) => ({
        type: "variants" as const,
        id: Variant.Id.make(String(variant.id)),
      })),
    },
  },
});

const reviewResource = (row: Row): typeof Review.Type => ({
  type: "reviews",
  id: Review.Id.make(String(row.id)),
  attributes: {
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
  attributes: { qty: Number(row.qty) },
  relationships: {
    variant: { data: { type: "variants", id: Variant.Id.make(String(row.variantId)) } },
  },
});

const orderResource = (row: Row): typeof Order.Type => ({
  type: "orders",
  id: Order.Id.make(String(row.id)),
  attributes: {
    status: String(row.status),
    totalCents: Number(row.totalCents),
    createdAt: String(row.createdAt),
  },
});

const orderItemResource = (row: Row): typeof OrderItem.Type => ({
  type: "orderItems",
  id: OrderItem.Id.make(String(row.id)),
  attributes: { qty: Number(row.qty), priceCents: Number(row.priceCents) },
  relationships: {
    order: { data: { type: "orders", id: Order.Id.make(String(row.orderId)) } },
    variant: { data: { type: "variants", id: Variant.Id.make(String(row.variantId)) } },
  },
});

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
  // The atomic operations extension over the writable resources. Errors are
  // per-operation (pointer-bearing) — see `OperationFailed`.
  .add(
    Group.make(
      "operations",
      Endpoint.operations([Review, CartItem, Order], {
        errors: [OperationUnauthorized, OperationNotFound, OperationConflict, OperationRejected],
      })
    )
  )
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

/**
 * These handlers write SQL directly, bypassing the sync protocol's push path
 * — so they announce the change themselves. `broadcast` is ADR-0022's single
 * verb for exactly that: subscribers whose windows may be affected are poked
 * and pull.
 */
const broadcast = (collection: string, ids: ReadonlyArray<string>) =>
  Effect.flatMap(CommerceSync, (sync) => sync.server.broadcast({ collection, ids }));

/** Brand plain route/form ids for typed client calls (example-level sugar). */
export const productId = Product.Id.make;
export const cartItemId = CartItem.Id.make;
export const variantId = Variant.Id.make;

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
        yield* broadcast("orders", [orderId]);
        yield* broadcast("orderItems", result.itemIds);
        yield* broadcast("cartItems", result.cartIds);
        yield* broadcast("variants", result.variantIds);
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

// ─── Atomic operations ───────────────────────────────────────────────────────
//
// One batch = one SQL transaction. Each operation is dispatched to the same
// rules the sync mutators enforce (`handlers.ts`, restated here over the
// JSON:API shapes rather than the mutator args): identity from the header,
// never the payload; a review's `userId` is the caller; a cart add checks the
// variant's stock; updates and removes only touch rows the caller owns; an
// order is recomputed from the authoritative cart. The first failure aborts
// the transaction — nothing from earlier operations persists — and answers
// one error document pointing at that operation. Relationship operations
// are out of scope here and refused.

type OperationEntry = {
  readonly data?: typeof Review.Type | typeof CartItem.Type | typeof Order.Type;
};

type BatchOperation = Atomic.Operation<typeof Review | typeof CartItem | typeof Order>["Type"];

interface Batch {
  /** The caller, from the header — checked per operation so the pointer names it. */
  readonly userId: string | undefined;
  /** Client-generated ids on `add`, by operation index (see `clientIdsOf`). */
  readonly clientIds: ReadonlyArray<string | undefined>;
  /** Server ids of lid-created resources, for later operations in the batch. */
  readonly lids: Lid.LidMap;
  /** collection → ids: one deduplicated broadcast per collection on commit. */
  readonly touched: Map<string, Set<string>>;
}

type ReviewRow = {
  id: string;
  productId: string;
  userId: string;
  authorName: string;
  rating: number;
  body: string;
  createdAt: string;
};
type CartItemRow = { id: string; userId: string; variantId: string; qty: number };
type OrderRow = { id: string; userId: string; status: string; totalCents: number; createdAt: string };

/**
 * effect-jsonapi 0.12's typed `add` operation carries `lid` but no `id`, so
 * a client-generated id is dropped by decoding — and `@legation/jsonapi`'s
 * atomic push always sends one, so a `JsonApiBackend` push must keep its
 * ids. As in #160's contract server, the id is recovered from the raw request
 * document (the body is cached, so re-reading it after decoding is free); an
 * `add` without one gets a server id, registered under its `lid` for later
 * operations in the batch.
 */
const clientIdsOf = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<ReadonlyArray<string | undefined>> =>
  request.json.pipe(
    Effect.orDie,
    Effect.map((raw) => {
      const operations = (raw as { readonly "atomic:operations"?: unknown } | null)?.[
        "atomic:operations"
      ];
      if (!Array.isArray(operations)) return [];
      return operations.map((operation: unknown) => {
        const id = (operation as { readonly data?: { readonly id?: unknown } } | null)?.data?.id;
        return typeof id === "string" && id.length > 0 ? id : undefined;
      });
    })
  );

const fail = (
  status: OperationFailed["status"],
  index: number,
  title: string,
  detail: string
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(new OperationFailed({ status, index, title, detail }));

const identityAt = (batch: Batch, index: number): Effect.Effect<string, OperationFailed> =>
  batch.userId === undefined
    ? fail(401, index, "Sign in first", "not signed in")
    : Effect.succeed(batch.userId);

/** A ref's id: as given, or the id an earlier `add` registered under its lid. */
const refId = (
  batch: Batch,
  index: number,
  ref: { readonly id: string } | { readonly lid: string }
): Effect.Effect<string, OperationFailed> => {
  if ("id" in ref) return Effect.succeed(ref.id);
  const id = batch.lids.id(ref.lid);
  return id === undefined
    ? fail(422, index, "Unknown lid", `no earlier operation in this request created lid "${ref.lid}"`)
    : Effect.succeed(id);
};

/** An `update`'s target: its `id`, or the id behind its `lid`. */
const updateTargetId = (
  batch: Batch,
  index: number,
  data: { readonly id?: string; readonly lid?: string }
): Effect.Effect<string, OperationFailed> =>
  data.id !== undefined
    ? Effect.succeed(data.id)
    : data.lid !== undefined
      ? refId(batch, index, { lid: data.lid })
      : fail(422, index, "Missing target", "an update needs an id or a lid");

/**
 * A client-generated id on `add` may only name a row the caller already owns
 * (an idempotent resend replaces it, like the mutators' INSERT OR REPLACE);
 * someone else's row is a 409.
 */
const ownedOrFree = (
  index: number,
  userId: string,
  existing: { readonly userId: string } | undefined,
  what: string
): Effect.Effect<void, OperationFailed> =>
  existing !== undefined && existing.userId !== userId
    ? fail(409, index, "Id already in use", `${what} id belongs to another user`)
    : Effect.void;

const touch = (batch: Batch, collection: string, ids: ReadonlyArray<string>): void => {
  const set = batch.touched.get(collection) ?? new Set<string>();
  for (const id of ids) set.add(id);
  batch.touched.set(collection, set);
};

const applyReview = (
  batch: Batch,
  index: number,
  op: Atomic.TargetsResource<BatchOperation, typeof Review>
): Effect.Effect<OperationEntry, OperationFailed | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const userId = yield* identityAt(batch, index);
    const load = (id: string) => sql<ReviewRow>`SELECT * FROM reviews WHERE id = ${id}`;
    // `review/write`'s rule, verbatim.
    const checkRating = (rating: number) =>
      rating < 1 || rating > 5
        ? fail(422, index, "Review rejected", "rating out of range")
        : Effect.void;
    switch (op.op) {
      case "add": {
        const id = batch.clientIds[index] ?? `r-${crypto.randomUUID()}`;
        const { authorName, rating, body, createdAt } = op.data.attributes;
        yield* checkRating(rating);
        const productId = yield* refId(batch, index, op.data.relationships.product.data);
        yield* ownedOrFree(index, userId, (yield* load(id))[0], "review");
        yield* sql`INSERT OR REPLACE INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
          VALUES (${id}, ${productId}, ${userId}, ${authorName}, ${rating}, ${body}, ${createdAt})`;
        if (op.data.lid !== undefined) batch.lids.assign(op.data.lid, id);
        touch(batch, "reviews", [id]);
        return { data: reviewResource((yield* load(id))[0]!) };
      }
      case "update": {
        const id = yield* updateTargetId(batch, index, op.data);
        const current = (yield* load(id))[0];
        if (current === undefined || current.userId !== userId) {
          return yield* fail(404, index, "Review not found", `no review ${id} of yours`);
        }
        const attributes = op.data.attributes ?? {};
        const rating = attributes.rating ?? current.rating;
        yield* checkRating(rating);
        const productRef = op.data.relationships?.product?.data;
        const productId =
          productRef === undefined ? current.productId : yield* refId(batch, index, productRef);
        yield* sql`UPDATE reviews
          SET productId = ${productId},
              authorName = ${attributes.authorName ?? current.authorName},
              rating = ${rating},
              body = ${attributes.body ?? current.body},
              createdAt = ${attributes.createdAt ?? current.createdAt}
          WHERE id = ${id}`;
        touch(batch, "reviews", [id]);
        return { data: reviewResource((yield* load(id))[0]!) };
      }
      case "remove": {
        const id = yield* refId(batch, index, op.ref);
        const current = (yield* load(id))[0];
        if (current === undefined || current.userId !== userId) {
          return yield* fail(404, index, "Review not found", `no review ${id} of yours`);
        }
        yield* sql`DELETE FROM reviews WHERE id = ${id} AND userId = ${userId}`;
        touch(batch, "reviews", [id]);
        return Atomic.emptyResult;
      }
    }
  });

const applyCartItem = (
  batch: Batch,
  index: number,
  op: Atomic.TargetsResource<BatchOperation, typeof CartItem>
): Effect.Effect<OperationEntry, OperationFailed | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const userId = yield* identityAt(batch, index);
    const load = (id: string) => sql<CartItemRow>`SELECT * FROM cartItems WHERE id = ${id}`;
    switch (op.op) {
      case "add": {
        const id = batch.clientIds[index] ?? `ci-${crypto.randomUUID()}`;
        const qty = op.data.attributes.qty;
        const variantId = yield* refId(batch, index, op.data.relationships.variant.data);
        // The stock rule is `cart/add`'s, verbatim.
        const variant = yield* sql<{
          stock: number;
        }>`SELECT stock FROM variants WHERE id = ${variantId}`;
        if (variant.length === 0) {
          return yield* fail(422, index, "Cart item rejected", "unknown variant");
        }
        if (variant[0]!.stock < qty) {
          return yield* fail(422, index, "Cart item rejected", "insufficient stock");
        }
        yield* ownedOrFree(index, userId, (yield* load(id))[0], "cart item");
        yield* sql`INSERT OR REPLACE INTO cartItems (id, userId, variantId, qty)
          VALUES (${id}, ${userId}, ${variantId}, ${qty})`;
        if (op.data.lid !== undefined) batch.lids.assign(op.data.lid, id);
        touch(batch, "cartItems", [id]);
        return { data: cartItemResource((yield* load(id))[0]!) };
      }
      case "update": {
        const id = yield* updateTargetId(batch, index, op.data);
        const current = (yield* load(id))[0];
        if (current === undefined || current.userId !== userId) {
          return yield* fail(404, index, "Cart item not found", `no cart item ${id} of yours`);
        }
        if (op.data.relationships?.variant !== undefined) {
          return yield* fail(
            422,
            index,
            "Cart item rejected",
            "a cart item's variant cannot be changed: remove it and add another"
          );
        }
        // `cart/setQty`: the quantity only — no stock check (placing the order checks).
        const qty = op.data.attributes?.qty ?? current.qty;
        yield* sql`UPDATE cartItems SET qty = ${qty} WHERE id = ${id} AND userId = ${userId}`;
        touch(batch, "cartItems", [id]);
        return { data: cartItemResource((yield* load(id))[0]!) };
      }
      case "remove": {
        const id = yield* refId(batch, index, op.ref);
        const current = (yield* load(id))[0];
        if (current === undefined || current.userId !== userId) {
          return yield* fail(404, index, "Cart item not found", `no cart item ${id} of yours`);
        }
        yield* sql`DELETE FROM cartItems WHERE id = ${id} AND userId = ${userId}`;
        touch(batch, "cartItems", [id]);
        return Atomic.emptyResult;
      }
    }
  });

/**
 * Order placement, recomputed from the authoritative cart exactly like
 * `order/place` (and the REST `create`): the payload's status and total are
 * ignored, items/total/stock derive server-side. An `add` re-sent with the
 * id of an order the caller already placed returns that order unchanged, so
 * a lost response cannot place it twice.
 */
const applyOrder = (
  batch: Batch,
  index: number,
  op: Atomic.TargetsResource<BatchOperation, typeof Order>
): Effect.Effect<OperationEntry, OperationFailed | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const userId = yield* identityAt(batch, index);
    if (op.op !== "add") {
      return yield* fail(422, index, "Order rejected", "orders are placed, never edited or removed");
    }
    const orderId = batch.clientIds[index] ?? `o-${crypto.randomUUID()}`;
    const load = () => sql<OrderRow>`SELECT * FROM orders WHERE id = ${orderId}`;
    const existing = (yield* load())[0];
    yield* ownedOrFree(index, userId, existing, "order");
    if (existing !== undefined) return { data: orderResource(existing) };

    const cart = yield* sql<{
      id: string;
      variantId: string;
      qty: number;
      priceCents: number;
      stock: number;
    }>`SELECT c.id, c.variantId, c.qty, v.priceCents, v.stock
       FROM cartItems c JOIN variants v ON v.id = c.variantId
       WHERE c.userId = ${userId}`;
    if (cart.length === 0) {
      return yield* fail(422, index, "Order rejected", "cart is empty");
    }
    const short = cart.find((line) => line.stock < line.qty);
    if (short !== undefined) {
      return yield* fail(422, index, "Order rejected", `insufficient stock for ${short.variantId}`);
    }
    const total = cart.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
    yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
      VALUES (${orderId}, ${userId}, 'placed', ${total}, ${op.data.attributes.createdAt})`;
    const itemIds: Array<string> = [];
    for (const [lineIndex, line] of cart.entries()) {
      const itemId = `${orderId}-${lineIndex}`;
      itemIds.push(itemId);
      yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
        VALUES (${itemId}, ${orderId}, ${userId}, ${line.variantId}, ${line.qty}, ${line.priceCents})`;
      yield* sql`UPDATE variants SET stock = stock - ${line.qty} WHERE id = ${line.variantId}`;
    }
    yield* sql`DELETE FROM cartItems WHERE userId = ${userId}`;
    if (op.data.lid !== undefined) batch.lids.assign(op.data.lid, orderId);
    touch(batch, "orders", [orderId]);
    touch(batch, "orderItems", itemIds);
    touch(batch, "cartItems", cart.map((line) => line.id));
    touch(batch, "variants", cart.map((line) => line.variantId));
    return { data: orderResource((yield* load())[0]!) };
  });

const applyOperation = (
  batch: Batch,
  index: number,
  operation: BatchOperation
): Effect.Effect<OperationEntry, OperationFailed | SqlError, SqlClient> => {
  if (Atomic.isRelationshipOperation(operation)) {
    return fail(422, index, "Unsupported operation", "relationship operations are not supported");
  }
  if (Atomic.targetsResource(operation, Review)) return applyReview(batch, index, operation);
  if (Atomic.targetsResource(operation, CartItem)) return applyCartItem(batch, index, operation);
  if (Atomic.targetsResource(operation, Order)) return applyOrder(batch, index, operation);
  return fail(422, index, "Unsupported operation", "unknown resource type");
};

const operationsLive = HttpApiBuilder.group(api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload, request }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const batch: Batch = {
        userId: yield* currentUser,
        clientIds: yield* clientIdsOf(request),
        lids: Lid.make(),
        touched: new Map(),
      };
      const entries = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const results: Array<OperationEntry> = [];
            for (const [index, operation] of payload["atomic:operations"].entries()) {
              results.push(yield* applyOperation(batch, index, operation));
            }
            return results;
          })
        )
        .pipe(
          // A statement failure is a server fault (500 — transient to a
          // pushing client); a rule failure is the batch's one error document.
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
          Effect.catchTag("OperationFailed", (failure) => Effect.fail(failureDocument(failure)))
        );
      // Committed: announce every touched collection once.
      for (const [collection, ids] of batch.touched) {
        yield* broadcast(collection, [...ids]);
      }
      return Atomic.results(entries);
    })
  )
);

/**
 * Content negotiation with the atomic extension declared. The `ext`
 * parameter is checked per request, and a bare `application/vnd.api+json`
 * stays acceptable, so the one middleware serves every group and the plain
 * endpoints behave exactly as before.
 */
const middleware = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] });

/** Registers the JSON:API's routes on the ambient `HttpRouter`. */
export const jsonApiLive = HttpApiBuilder.layer(api).pipe(
  Layer.provide(
    Layer.mergeAll(
      categoriesLive,
      productsLive,
      reviewsLive,
      cartItemsLive,
      ordersLive,
      orderItemsLive,
      operationsLive
    ).pipe(Layer.provide(middleware))
  ),
  Layer.provide(middleware)
);
