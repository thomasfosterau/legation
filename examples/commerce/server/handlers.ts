/**
 * Authoritative mutator handlers — the server half of each mutator
 * (ADR-0008), running SQL inside SqlBackend's push transaction. Args are
 * decoded with the domain schemas (never trusted as-cast), and identity
 * comes from the resolver (never from args): a mismatch is a permanent
 * rejection, so a forged `userId` can't poison the queue.
 *
 * Statements are Effect SQL tagged templates over the shared `SqlClient`;
 * they participate in the surrounding push transaction because
 * `SqlExecutor.transaction` is `sql.withTransaction` on the same client.
 */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Backend, BackendError, MutationRejected } from "@legation/effect";
import type { SqlBackend } from "@legation/sql";
import {
  CartAddArgs,
  CartRemoveArgs,
  CartSetQtyArgs,
  OrderPlaceArgs,
  ProfileUpdateArgs,
  ReviewWriteArgs,
} from "../src/lib/domain.js";

export const tables: Readonly<Record<string, SqlBackend.TableMapping>> = {
  categories: { table: "categories" },
  sellers: { table: "sellers" },
  products: { table: "products" },
  variants: { table: "variants" },
  reviews: { table: "reviews" },
  profiles: { table: "profiles" },
  cartItems: { table: "cartItems" },
  orders: { table: "orders" },
  orderItems: { table: "orderItems" },
};

/** Malformed args are a permanent rejection — replaying them can't succeed. */
const decode = <S extends Schema.Top>(
  schema: S,
  raw: unknown
): Effect.Effect<S["Type"], MutationRejected, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError((error) => new MutationRejected({ reason: `invalid args: ${error.message}` }))
  );

const requireUser = (
  context: Backend.SyncContext,
  claimed: string
): Effect.Effect<string, MutationRejected> => {
  const identity = typeof context.identity === "string" ? context.identity : undefined;
  if (identity === undefined) {
    return Effect.fail(new MutationRejected({ reason: "not signed in" }));
  }
  if (identity !== claimed) {
    return Effect.fail(new MutationRejected({ reason: "identity mismatch" }));
  }
  return Effect.succeed(identity);
};

const hint = (collection: string, ids: ReadonlyArray<string>): Backend.ChangeHint => ({
  collection,
  ids,
});

/** A statement failure is transient (aborts the push); rejections are explicit. */
const transient = <A, R>(
  effect: Effect.Effect<A, MutationRejected | SqlError, R>
): Effect.Effect<A, MutationRejected | BackendError, R> =>
  Effect.mapError(effect, (error) =>
    error._tag === "SqlError"
      ? new BackendError({ message: "statement failed", cause: error })
      : error
  );

export const makeHandlers = (sql: SqlClient): Readonly<Record<string, SqlBackend.SqlHandler>> => ({
  "cart/add": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(CartAddArgs, raw);
      const userId = yield* requireUser(context, args.userId);
      const variant = yield* sql<{ stock: number }>`
        SELECT stock FROM variants WHERE id = ${args.variantId}`;
      if (variant.length === 0) {
        return yield* Effect.fail(new MutationRejected({ reason: "unknown variant" }));
      }
      if (variant[0]!.stock < args.qty) {
        return yield* Effect.fail(new MutationRejected({ reason: "insufficient stock" }));
      }
      yield* sql`INSERT OR REPLACE INTO cartItems (id, userId, variantId, qty)
        VALUES (${args.id}, ${userId}, ${args.variantId}, ${args.qty})`;
      return [hint("cartItems", [args.id])];
    }).pipe(transient),

  "cart/setQty": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(CartSetQtyArgs, raw);
      const userId = yield* requireUser(context, args.userId);
      yield* sql`UPDATE cartItems SET qty = ${args.qty}
        WHERE id = ${args.id} AND userId = ${userId}`;
      return [hint("cartItems", [args.id])];
    }).pipe(transient),

  "cart/remove": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(CartRemoveArgs, raw);
      const userId = yield* requireUser(context, args.userId);
      yield* sql`DELETE FROM cartItems WHERE id = ${args.id} AND userId = ${userId}`;
      return [hint("cartItems", [args.id])];
    }).pipe(transient),

  // Recomputes the order from the authoritative cart (args.items only drove
  // the client's optimistic overlay) — replay-as-conflict-resolution.
  "order/place": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(OrderPlaceArgs, raw);
      const userId = yield* requireUser(context, args.userId);
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
        return yield* Effect.fail(new MutationRejected({ reason: "cart is empty" }));
      }
      const short = cart.find((line) => line.stock < line.qty);
      if (short !== undefined) {
        return yield* Effect.fail(
          new MutationRejected({ reason: `insufficient stock for ${short.variantId}` })
        );
      }
      const total = cart.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
      yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
        VALUES (${args.orderId}, ${userId}, 'placed', ${total}, ${args.createdAt})`;
      const itemIds: Array<string> = [];
      const touchedVariants: Array<string> = [];
      for (const [index, line] of cart.entries()) {
        const itemId = `${args.orderId}-${index}`;
        itemIds.push(itemId);
        touchedVariants.push(line.variantId);
        yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
          VALUES (${itemId}, ${args.orderId}, ${userId}, ${line.variantId}, ${line.qty}, ${line.priceCents})`;
        yield* sql`UPDATE variants SET stock = stock - ${line.qty} WHERE id = ${line.variantId}`;
      }
      yield* sql`DELETE FROM cartItems WHERE userId = ${userId}`;
      return [
        hint("orders", [args.orderId]),
        hint("orderItems", itemIds),
        hint("cartItems", cart.map((line) => line.id)),
        hint("variants", touchedVariants),
      ];
    }).pipe(transient),

  "review/write": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(ReviewWriteArgs, raw);
      const userId = yield* requireUser(context, args.userId);
      if (args.rating < 1 || args.rating > 5) {
        return yield* Effect.fail(new MutationRejected({ reason: "rating out of range" }));
      }
      yield* sql`INSERT OR REPLACE INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
        VALUES (${args.id}, ${args.productId}, ${userId}, ${args.authorName}, ${args.rating}, ${args.body}, ${args.createdAt})`;
      return [hint("reviews", [args.id])];
    }).pipe(transient),

  "profile/update": (raw, _tx, context) =>
    Effect.gen(function* () {
      const args = yield* decode(ProfileUpdateArgs, raw);
      const userId = yield* requireUser(context, args.id);
      yield* sql`INSERT OR REPLACE INTO profiles (id, name) VALUES (${userId}, ${args.name})`;
      return [hint("profiles", [userId])];
    }).pipe(transient),
});
