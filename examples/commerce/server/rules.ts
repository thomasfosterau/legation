/**
 * The commerce write rules — one statement of each, shared by every write path
 * (#525): the sync mutators' server halves (`handlers.ts`, the app's named
 * intents and the graph-derived `{type}/{operation}` mutations the façade
 * journals), the per-resource `POST` / `DELETE` handlers and the atomic
 * operations endpoint (`jsonapi.ts`). Each path differs only in where the
 * caller and the args come from and in how a {@link RuleRejected} reaches its
 * wire: a `MutationRejected` for a push, an error document for a request.
 *
 * The rules:
 *
 * - **Ownership.** A client id may only name a row the caller already owns:
 *   a resend replaces (or, for an order, returns) it, someone else's row is a
 *   409. The caller is the resolved identity, never a payload field.
 * - **A cart line** names a known variant with stock for its quantity. A line
 *   already gone deletes as a no-op, so a resent remove is not a rejection.
 * - **A review's** rating is 1–5.
 * - **An order** is recomputed from the authoritative cart: its items, total
 *   and the stock it takes all derive server-side, and the cart is emptied.
 *   An order the caller already placed under the same id is returned
 *   unchanged, so a lost response cannot place it twice.
 *
 * Every rule runs inside the caller's transaction (a push, a batch, or the
 * per-resource handler's own) and reports the rows it wrote, so each path
 * announces them its own way.
 */
import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** A rule's refusal: the status a request answers, and the reason a push records. */
export class RuleRejected extends Data.TaggedError("RuleRejected")<{
  readonly status: 404 | 409 | 422;
  readonly title: string;
  readonly detail: string;
}> {}

/** The rows a rule wrote, by collection — each path's invalidation. */
export type Touched = ReadonlyArray<{ readonly collection: string; readonly ids: ReadonlyArray<string> }>;

export type ReviewRow = {
  id: string;
  productId: string;
  userId: string;
  authorName: string;
  rating: number;
  body: string;
  createdAt: string;
};
export type CartItemRow = { id: string; userId: string; variantId: string; qty: number };
export type OrderRow = {
  id: string;
  userId: string;
  status: string;
  totalCents: number;
  createdAt: string;
};

type Written<Row> = { readonly row: Row; readonly touched: Touched };
type Rule<A> = Effect.Effect<A, RuleRejected | SqlError, SqlClient>;

const reject = (status: RuleRejected["status"], title: string, detail: string) =>
  Effect.fail(new RuleRejected({ status, title, detail }));

/** A client id is free, or already the caller's. */
const ownedOrFree = (
  userId: string,
  existing: { readonly userId: string } | undefined,
  what: string
): Effect.Effect<void, RuleRejected> =>
  existing !== undefined && existing.userId !== userId
    ? reject(409, "Id already in use", `${what} id belongs to another user`)
    : Effect.void;

export const loadReview = (id: string): Rule<ReviewRow | undefined> =>
  Effect.flatMap(SqlClient, (sql) =>
    Effect.map(sql<ReviewRow>`SELECT * FROM reviews WHERE id = ${id}`, (rows) => rows[0])
  );

export const loadCartItem = (id: string): Rule<CartItemRow | undefined> =>
  Effect.flatMap(SqlClient, (sql) =>
    Effect.map(sql<CartItemRow>`SELECT * FROM cartItems WHERE id = ${id}`, (rows) => rows[0])
  );

export const loadOrder = (id: string): Rule<OrderRow | undefined> =>
  Effect.flatMap(SqlClient, (sql) =>
    Effect.map(sql<OrderRow>`SELECT * FROM orders WHERE id = ${id}`, (rows) => rows[0])
  );

/** A review's rating is 1–5. */
export const checkRating = (rating: number): Effect.Effect<void, RuleRejected> =>
  rating < 1 || rating > 5 ? reject(422, "Review rejected", "rating out of range") : Effect.void;

/** Write (or, for a resend of the caller's own id, replace) a review authored by the caller. */
export const writeReview = (input: {
  readonly userId: string;
  readonly id: string;
  readonly productId: string;
  readonly authorName: string;
  readonly rating: number;
  readonly body: string;
  readonly createdAt: string;
}): Rule<Written<ReviewRow>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* checkRating(input.rating);
    yield* ownedOrFree(input.userId, yield* loadReview(input.id), "review");
    yield* sql`INSERT OR REPLACE INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
      VALUES (${input.id}, ${input.productId}, ${input.userId}, ${input.authorName}, ${input.rating}, ${input.body}, ${input.createdAt})`;
    return {
      row: (yield* loadReview(input.id))!,
      touched: [{ collection: "reviews", ids: [input.id] }],
    };
  });

/** Add a cart line for the caller: a known variant, with stock for the quantity. */
export const addCartItem = (input: {
  readonly userId: string;
  readonly id: string;
  readonly variantId: string;
  readonly qty: number;
}): Rule<Written<CartItemRow>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const variant = yield* sql<{ stock: number }>`SELECT stock FROM variants WHERE id = ${input.variantId}`;
    if (variant.length === 0) return yield* reject(422, "Cart item rejected", "unknown variant");
    if (variant[0]!.stock < input.qty) {
      return yield* reject(422, "Cart item rejected", "insufficient stock");
    }
    yield* ownedOrFree(input.userId, yield* loadCartItem(input.id), "cart item");
    yield* sql`INSERT OR REPLACE INTO cartItems (id, userId, variantId, qty)
      VALUES (${input.id}, ${input.userId}, ${input.variantId}, ${input.qty})`;
    return {
      row: (yield* loadCartItem(input.id))!,
      touched: [{ collection: "cartItems", ids: [input.id] }],
    };
  });

/**
 * Remove one of the caller's cart lines. A line already gone is a no-op (a
 * resent remove must not read as a rejection); someone else's is not found.
 */
export const removeCartItem = (input: {
  readonly userId: string;
  readonly id: string;
}): Rule<Touched> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const current = yield* loadCartItem(input.id);
    if (current === undefined) return [];
    if (current.userId !== input.userId) {
      return yield* reject(404, "Cart item not found", `no cart item ${input.id} of yours`);
    }
    yield* sql`DELETE FROM cartItems WHERE id = ${input.id} AND userId = ${input.userId}`;
    return [{ collection: "cartItems", ids: [input.id] }];
  });

/**
 * Place the caller's order from the authoritative cart. The payload's items,
 * status and total are never read: only the id and `createdAt` come from the
 * caller.
 */
export const placeOrder = (input: {
  readonly userId: string;
  readonly id: string;
  readonly createdAt: string;
}): Rule<Written<OrderRow>> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const existing = yield* loadOrder(input.id);
    yield* ownedOrFree(input.userId, existing, "order");
    if (existing !== undefined) return { row: existing, touched: [] };

    const cart = yield* sql<{
      id: string;
      variantId: string;
      qty: number;
      priceCents: number;
      stock: number;
    }>`SELECT c.id, c.variantId, c.qty, v.priceCents, v.stock
       FROM cartItems c JOIN variants v ON v.id = c.variantId
       WHERE c.userId = ${input.userId}`;
    if (cart.length === 0) return yield* reject(422, "Order rejected", "cart is empty");
    const short = cart.find((line) => line.stock < line.qty);
    if (short !== undefined) {
      return yield* reject(422, "Order rejected", `insufficient stock for ${short.variantId}`);
    }
    const total = cart.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
    yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
      VALUES (${input.id}, ${input.userId}, 'placed', ${total}, ${input.createdAt})`;
    const itemIds = cart.map((_, index) => `${input.id}-${index}`);
    yield* Effect.forEach(
      cart,
      (line, index) =>
        Effect.andThen(
          sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
            VALUES (${itemIds[index]!}, ${input.id}, ${input.userId}, ${line.variantId}, ${line.qty}, ${line.priceCents})`,
          sql`UPDATE variants SET stock = stock - ${line.qty} WHERE id = ${line.variantId}`
        ),
      { discard: true }
    );
    yield* sql`DELETE FROM cartItems WHERE userId = ${input.userId}`;
    return {
      row: (yield* loadOrder(input.id))!,
      touched: [
        { collection: "orders", ids: [input.id] },
        { collection: "orderItems", ids: itemIds },
        { collection: "cartItems", ids: cart.map((line) => line.id) },
        { collection: "variants", ids: cart.map((line) => line.variantId) },
      ],
    };
  });
