/**
 * Authoritative mutator handlers — the server half of each mutator
 * (ADR-0008), running SQL inside SqlBackend's push transaction. Identity
 * comes from the resolver (never from args): a mismatch is a permanent
 * rejection, so a forged `userId` can't poison the queue.
 */
import { Effect } from "effect";
import { Backend, BackendError, MutationRejected } from "@legation/effect";
import type { SqlBackend } from "@legation/sql";
import type { CartAdd, CartRemove, CartSetQty, OrderPlace, Profile, Review } from "../src/lib/domain.js";

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

export const handlers: Readonly<Record<string, SqlBackend.SqlHandler>> = {
  "cart/add": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as CartAdd;
      const userId = yield* requireUser(context, args.userId);
      const variant = yield* tx.query({
        text: "SELECT stock FROM variants WHERE id = ?",
        params: [args.variantId],
      });
      if (variant.length === 0) {
        return yield* Effect.fail(new MutationRejected({ reason: "unknown variant" }));
      }
      if ((variant[0]!.stock as number) < args.qty) {
        return yield* Effect.fail(new MutationRejected({ reason: "insufficient stock" }));
      }
      yield* tx.run({
        text: "INSERT OR REPLACE INTO cartItems (id, userId, variantId, qty) VALUES (?, ?, ?, ?)",
        params: [args.id, userId, args.variantId, args.qty],
      });
      return [hint("cartItems", [args.id])];
    }),

  "cart/setQty": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as CartSetQty;
      const userId = yield* requireUser(context, args.userId);
      yield* tx.run({
        text: "UPDATE cartItems SET qty = ? WHERE id = ? AND userId = ?",
        params: [args.qty, args.id, userId],
      });
      return [hint("cartItems", [args.id])];
    }),

  "cart/remove": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as CartRemove;
      const userId = yield* requireUser(context, args.userId);
      yield* tx.run({
        text: "DELETE FROM cartItems WHERE id = ? AND userId = ?",
        params: [args.id, userId],
      });
      return [hint("cartItems", [args.id])];
    }),

  // Recomputes the order from the authoritative cart (args.items only drove
  // the client's optimistic overlay) — replay-as-conflict-resolution.
  "order/place": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as OrderPlace;
      const userId = yield* requireUser(context, args.userId);
      const cart = (yield* tx.query({
        text: `SELECT c.id, c.variantId, c.qty, v.priceCents, v.stock
               FROM cartItems c JOIN variants v ON v.id = c.variantId
               WHERE c.userId = ?`,
        params: [userId],
      })) as ReadonlyArray<{
        id: string;
        variantId: string;
        qty: number;
        priceCents: number;
        stock: number;
      }>;
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
      yield* tx.run({
        text: "INSERT INTO orders (id, userId, status, totalCents, createdAt) VALUES (?, ?, 'placed', ?, ?)",
        params: [args.orderId, userId, total, args.createdAt],
      });
      const itemIds: Array<string> = [];
      const touchedVariants: Array<string> = [];
      for (const [index, line] of cart.entries()) {
        const itemId = `${args.orderId}-${index}`;
        itemIds.push(itemId);
        touchedVariants.push(line.variantId);
        yield* tx.run({
          text: "INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents) VALUES (?, ?, ?, ?, ?, ?)",
          params: [itemId, args.orderId, userId, line.variantId, line.qty, line.priceCents],
        });
        yield* tx.run({
          text: "UPDATE variants SET stock = stock - ? WHERE id = ?",
          params: [line.qty, line.variantId],
        });
      }
      yield* tx.run({ text: "DELETE FROM cartItems WHERE userId = ?", params: [userId] });
      return [
        hint("orders", [args.orderId]),
        hint("orderItems", itemIds),
        hint("cartItems", cart.map((line) => line.id)),
        hint("variants", touchedVariants),
      ];
    }),

  "review/write": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as Review;
      const userId = yield* requireUser(context, args.userId);
      if (args.rating < 1 || args.rating > 5) {
        return yield* Effect.fail(new MutationRejected({ reason: "rating out of range" }));
      }
      yield* tx.run({
        text: `INSERT OR REPLACE INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [args.id, args.productId, userId, args.authorName, args.rating, args.body, args.createdAt],
      });
      return [hint("reviews", [args.id])];
    }),

  "profile/update": (raw, tx, context) =>
    Effect.gen(function* () {
      const args = raw as Profile;
      const userId = yield* requireUser(context, args.id);
      yield* tx.run({
        text: "INSERT OR REPLACE INTO profiles (id, name) VALUES (?, ?)",
        params: [userId, args.name],
      });
      return [hint("profiles", [userId])];
    }),
};

/** Transient-failure escape hatch used by the demo (not registered). */
export const transient = (message: string): Effect.Effect<never, BackendError> =>
  Effect.fail(new BackendError({ message }));
