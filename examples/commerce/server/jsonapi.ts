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
 * The `operations` group is the JSON:API Atomic Operations extension over
 * the same rules: one request carrying an ordered batch of `add` / `update`
 * / `remove` operations on reviews, cart items and orders, applied inside one
 * SQL transaction — the first failure rolls the whole batch back and names
 * the failing operation. `@thomasfosterau/legation-jsonapi`'s `JsonApiBackend` pushes its
 * journal through it as one request per batch when the api advertises it.
 *
 * The api's shape — endpoints and wire errors — lives in `src/lib/api.ts`,
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
import { Context, Data, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpServerRequest } from "effect/http";
import { HttpServerRequest as Request } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ApiError, Atomic, Handlers, Lid, Middleware } from "@thomasfosterau/effect-jsonapi";
import type { Backend } from "@thomasfosterau/legation-effect";
import { RestHandlers } from "@thomasfosterau/legation-jsonapi";
import { nodes } from "../src/lib/domain.js";
import { api, NotFound, Unauthorized } from "../src/lib/api.js";
import type { OperationRejected } from "../src/lib/api.js";
import { CartItem, Category, Order, OrderItem, Product, Review, Variant } from "../src/lib/resources.js";
import type { RuleRejected, Touched } from "./rules.js";
import {
  addCartItem,
  checkRating,
  placeOrder,
  removeCartItem,
  writeReview,
} from "./rules.js";
import type { CartItemRow, ReviewRow } from "./rules.js";
import { authPolicy, CommerceSync } from "./runtime.js";

export {
  api,
  NotFound,
  OperationConflict,
  OperationNotFound,
  OperationRejected,
  OperationUnauthorized,
  Unauthorized,
} from "../src/lib/api.js";

/**
 * One operation's failure inside an atomic batch — the in-handler form. The
 * extension wants the error document to name the failing operation through
 * `source.pointer`; `ApiError.make` carries custom fields under `meta`, not
 * `source`, so the wire shape is declared structurally in `src/lib/api.ts`
 * (any `{ status, wire }` is an `ErrorClass`, one per status) and this class
 * is what the batch logic fails with. `detail` doubles as the rejection reason a pushing
 * `JsonApiBackend` records, so it mirrors the sync mutators' reasons.
 */
class OperationFailed extends Data.TaggedError("OperationFailed")<{
  readonly status: 401 | 404 | 409 | 422;
  readonly index: number;
  readonly title: string;
  readonly detail: string;
}> {}

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

/**
 * A per-resource create's client id (#525): effect-jsonapi's `createPayload`
 * carries `lid` but no `id`, so decoding drops it; recover it from the raw
 * document (the body is cached, so re-reading it is free), as the atomic
 * endpoint does. An online forward and an offline journal of one create then
 * name the same row. Without one, the server mints an id.
 */
const clientIdOf = (prefix: string): Effect.Effect<string, never, HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(Request.HttpServerRequest, (request) =>
    request.json.pipe(
      Effect.orDie,
      Effect.map((raw) => {
        const id = (raw as { readonly data?: { readonly id?: unknown } } | null)?.data?.id;
        return typeof id === "string" && id.length > 0 ? id : `${prefix}-${crypto.randomUUID()}`;
      })
    )
  );

/** A shared rule (`rules.ts`) as a request step: a refusal is the error document `toError` names. */
const restRule = <A, E, R>(
  effect: Effect.Effect<A, RuleRejected | SqlError, R>,
  toError: (rejected: RuleRejected) => E
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchTag("RuleRejected", (rejected) => Effect.fail(toError(rejected))),
    Effect.catchTag("SqlError", Effect.die)
  );

/** A create's refusal: someone else's client id is a 409, a broken rule a 400. */
const createRefused = (rejected: RuleRejected): ApiError.Conflict | ApiError.BadRequest =>
  rejected.status === 409
    ? new ApiError.Conflict({ detail: rejected.detail })
    : new ApiError.BadRequest({ detail: rejected.detail });

/** A delete's refusal: someone else's row is not found. */
const deleteRefused = (_rejected: RuleRejected): NotFound => new NotFound();

/** Announce what a rule wrote, one broadcast per collection. */
const announce = (touched: Touched) =>
  Effect.forEach(touched, ({ collection, ids }) => broadcast(collection, ids), { discard: true });

const reviewsLive = HttpApiBuilder.group(api, "reviews", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers.handle("list", rest.list(Review)).handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const sql = yield* SqlClient;
        const id = yield* clientIdOf("r");
        const { row, touched } = yield* restRule(
          sql.withTransaction(
            writeReview({
              userId,
              id,
              productId: payload.data.relationships.product.data.id,
              ...payload.data.attributes,
            })
          ),
          createRefused
        );
        yield* announce(touched);
        return Handlers.data(reviewResource(row));
      })
    )
  )
);

const cartItemsLive = HttpApiBuilder.group(api, "cartItems", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers
      .handle("list", rest.list(CartItem))
      .handle("get", rest.get(CartItem, notFound))
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
          const id = yield* clientIdOf("ci");
          const { row, touched } = yield* restRule(
            sql.withTransaction(
              addCartItem({
                userId,
                id,
                variantId: payload.data.relationships.variant.data.id,
                qty: payload.data.attributes.qty,
              })
            ),
            createRefused
          );
          yield* announce(touched);
          return Handlers.data(cartItemResource(row));
        })
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
          yield* announce(
            yield* restRule(
              sql.withTransaction(removeCartItem({ userId, id: params.id })),
              deleteRefused
            )
          );
        })
      )
  )
);

const ordersLive = HttpApiBuilder.group(api, "orders", (handlers) =>
  Effect.map(Rest, (rest) =>
    handlers
      .handle("list", rest.list(Order))
      // Order placement: recomputed from the authoritative cart (`rules.ts`'s
      // `placeOrder`) — the client's payload only carries the metadata
      // (createdAt); items/total/stock all derive server-side.
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* requireUser;
          const sql = yield* SqlClient;
          const id = yield* clientIdOf("o");
          const { row, touched } = yield* restRule(
            sql.withTransaction(
              placeOrder({ userId, id, createdAt: payload.data.attributes.createdAt })
            ),
            createRefused
          );
          yield* announce(touched);
          return Handlers.data(orderResource(row));
        })
      )
  )
);

const orderItemsLive = HttpApiBuilder.group(api, "orderItems", (handlers) =>
  Effect.map(Rest, (rest) => handlers.handle("list", rest.list(OrderItem)))
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
  /** The resource type each lid's `add` created, so a ref cannot cross types. */
  readonly lidTypes: Map<string, string>;
  /** collection → ids: one deduplicated broadcast per collection on commit. */
  readonly touched: Map<string, Set<string>>;
}

/**
 * effect-jsonapi's typed `add` operation carries `lid` but no `id`, so a
 * client-generated id is dropped by decoding — and `@thomasfosterau/legation-jsonapi`'s
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

/** Register an `add`'s lid with the type it created, for later refs in the batch. */
const assignLid = (batch: Batch, lid: string | undefined, type: string, id: string): void => {
  if (lid === undefined) return;
  batch.lids.assign(lid, id);
  batch.lidTypes.set(lid, type);
};

const identityAt = (batch: Batch, index: number): Effect.Effect<string, OperationFailed> =>
  batch.userId === undefined
    ? fail(401, index, "Sign in first", "not signed in")
    : Effect.succeed(batch.userId);

type Ref = { readonly type: string } & ({ readonly id: string } | { readonly lid: string });

/**
 * A ref's id: as given, or the id an earlier `add` registered under its lid.
 * A lid only stands for the type its `add` created, so a review cannot point
 * its `product` at a cart item made earlier in the batch.
 */
const refId = (batch: Batch, index: number, ref: Ref): Effect.Effect<string, OperationFailed> => {
  if ("id" in ref) return Effect.succeed(ref.id);
  const id = batch.lids.id(ref.lid);
  if (id === undefined) {
    return fail(
      422,
      index,
      "Unknown lid",
      `no earlier operation in this request created lid "${ref.lid}"`
    );
  }
  const created = batch.lidTypes.get(ref.lid);
  return created === ref.type
    ? Effect.succeed(id)
    : fail(422, index, "Wrong lid type", `lid "${ref.lid}" names a ${created}, not a ${ref.type}`);
};

/** An `update`'s target: its `data.id`, the id behind its `data.lid`, or its `ref`. */
const updateTargetId = (
  batch: Batch,
  index: number,
  data: { readonly type: string; readonly id?: string; readonly lid?: string },
  ref: Ref | undefined
): Effect.Effect<string, OperationFailed> =>
  data.id !== undefined
    ? Effect.succeed(data.id)
    : data.lid !== undefined
      ? refId(batch, index, { type: data.type, lid: data.lid })
      : ref !== undefined
        ? refId(batch, index, ref)
        : fail(422, index, "Missing target", "an update needs an id, a lid or a ref");

/** A shared rule (`rules.ts`) as one batch operation: a refusal names the operation. */
const atomicRule = <A>(
  index: number,
  effect: Effect.Effect<A, RuleRejected | SqlError, SqlClient>
): Effect.Effect<A, OperationFailed | SqlError, SqlClient> =>
  Effect.catchTag(effect, "RuleRejected", (rejected) =>
    fail(rejected.status, index, rejected.title, rejected.detail)
  );

/** Record what a rule wrote, for the batch's broadcast on commit. */
const touchAll = (batch: Batch, touched: Touched): void => {
  for (const { collection, ids } of touched) touch(batch, collection, ids);
};

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
    switch (op.op) {
      case "add": {
        const id = batch.clientIds[index] ?? `r-${crypto.randomUUID()}`;
        const productId = yield* refId(batch, index, op.data.relationships.product.data);
        const { row, touched } = yield* atomicRule(
          index,
          writeReview({ userId, id, productId, ...op.data.attributes })
        );
        assignLid(batch, op.data.lid, "reviews", id);
        touchAll(batch, touched);
        return { data: reviewResource(row) };
      }
      case "update": {
        const id = yield* updateTargetId(batch, index, op.data, op.ref);
        const current = (yield* load(id))[0];
        if (current === undefined || current.userId !== userId) {
          return yield* fail(404, index, "Review not found", `no review ${id} of yours`);
        }
        const attributes = op.data.attributes ?? {};
        const rating = attributes.rating ?? current.rating;
        yield* atomicRule(index, checkRating(rating));
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
        // A row already gone is a no-op, as the mutators' deletes are: a
        // batch resent after a lost response must not read as a rejection.
        if (current === undefined) return Atomic.emptyResult;
        if (current.userId !== userId) {
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
        const variantId = yield* refId(batch, index, op.data.relationships.variant.data);
        const { row, touched } = yield* atomicRule(
          index,
          addCartItem({ userId, id, variantId, qty: op.data.attributes.qty })
        );
        assignLid(batch, op.data.lid, "cartItems", id);
        touchAll(batch, touched);
        return { data: cartItemResource(row) };
      }
      case "update": {
        const id = yield* updateTargetId(batch, index, op.data, op.ref);
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
        touchAll(batch, yield* atomicRule(index, removeCartItem({ userId, id })));
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
    const userId = yield* identityAt(batch, index);
    if (op.op !== "add") {
      return yield* fail(422, index, "Order rejected", "orders are placed, never edited or removed");
    }
    const orderId = batch.clientIds[index] ?? `o-${crypto.randomUUID()}`;
    const { row, touched } = yield* atomicRule(
      index,
      placeOrder({ userId, id: orderId, createdAt: op.data.attributes.createdAt })
    );
    assignLid(batch, op.data.lid, "orders", orderId);
    touchAll(batch, touched);
    return { data: orderResource(row) };
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
      const operations = payload["atomic:operations"];
      // The raw ids line up with the decoded operations by index; if the two
      // ever disagree in length, trust neither and assign server ids.
      const clientIds = yield* clientIdsOf(request);
      const batch: Batch = {
        userId: yield* currentUser,
        clientIds: clientIds.length === operations.length ? clientIds : [],
        lids: Lid.make(),
        lidTypes: new Map(),
        touched: new Map(),
      };
      const entries = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const results: Array<OperationEntry> = [];
            for (const [index, operation] of operations.entries()) {
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
      variantsLive,
      reviewsLive,
      cartItemsLive,
      ordersLive,
      orderItemsLive,
      operationsLive
    ).pipe(Layer.provide(middleware), Layer.provide(restLive))
  ),
  Layer.provide(middleware)
);
