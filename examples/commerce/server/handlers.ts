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
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Backend, BackendError, MutationRejected } from "@thomasfosterau/legation-effect";
import type { SqlBackend } from "@thomasfosterau/legation-sql";
import {
  CartAddArgs,
  CartRemoveArgs,
  CartSetQtyArgs,
  OrderPlaceArgs,
  ProfileUpdateArgs,
  ReviewWriteArgs,
} from "../src/lib/domain.js";
import type { RuleRejected, Touched } from "./rules.js";
import { addCartItem, placeOrder, removeCartItem, writeReview } from "./rules.js";

/**
 * The graph-derived mutations' args (`CrudMutation`), in the graph row form the
 * worker's JSON:API façade journals a reflected `POST` / `DELETE` as
 * (ADR-0030 §5): attributes and `one`-edge `via` keys side by side. The owner
 * is the caller, never the payload; a `userId` sent along must be the caller's.
 * A create's other server-set fields (an order's status and total) are never
 * read.
 */
const ReviewCreateArgs = Schema.Struct({
  type: Schema.Literal("reviews"),
  id: Schema.String,
  attributes: Schema.Struct({
    productId: Schema.String,
    authorName: Schema.String,
    rating: Schema.Number,
    body: Schema.String,
    createdAt: Schema.String,
    userId: Schema.optional(Schema.String),
  }),
});

const CartItemCreateArgs = Schema.Struct({
  type: Schema.Literal("cartItems"),
  id: Schema.String,
  attributes: Schema.Struct({
    variantId: Schema.String,
    qty: Schema.Number,
    userId: Schema.optional(Schema.String),
  }),
});

const CartItemDeleteArgs = Schema.Struct({ type: Schema.Literal("cartItems"), id: Schema.String });

const OrderCreateArgs = Schema.Struct({
  type: Schema.Literal("orders"),
  id: Schema.String,
  attributes: Schema.Struct({
    createdAt: Schema.String,
    userId: Schema.optional(Schema.String),
  }),
});

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

/** A derived mutation's caller: the identity, which a `userId` sent along must match. */
const callerOf = (
  context: Backend.SyncContext,
  claimed: string | undefined
): Effect.Effect<string, MutationRejected> => {
  const identity = typeof context.identity === "string" ? context.identity : undefined;
  return requireUser(context, claimed ?? identity ?? "");
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

export const makeHandlers = (sql: SqlClient): Readonly<Record<string, SqlBackend.SqlHandler>> => {
  /** A shared rule (`rules.ts`) as a push step: a refusal is a permanent rejection. */
  const rule = <A>(
    effect: Effect.Effect<A, RuleRejected | SqlError, SqlClient>
  ): Effect.Effect<A, MutationRejected | SqlError> =>
    effect.pipe(
      Effect.catchTag("RuleRejected", (rejected) =>
        Effect.fail(new MutationRejected({ reason: rejected.detail }))
      ),
      Effect.provideService(SqlClient, sql)
    );
  const hints = (touched: Touched): ReadonlyArray<Backend.ChangeHint> =>
    touched.map(({ collection, ids }) => hint(collection, ids));

  const addLine = (input: Parameters<typeof addCartItem>[0]) =>
    Effect.map(rule(addCartItem(input)), ({ touched }) => hints(touched));
  const removeLine = (input: Parameters<typeof removeCartItem>[0]) =>
    Effect.map(rule(removeCartItem(input)), hints);
  const place = (input: Parameters<typeof placeOrder>[0]) =>
    Effect.map(rule(placeOrder(input)), ({ touched }) => hints(touched));
  const review = (input: Parameters<typeof writeReview>[0]) =>
    Effect.map(rule(writeReview(input)), ({ touched }) => hints(touched));

  return {
    "cart/add": (raw, _tx, context) =>
      Effect.gen(function* () {
        const args = yield* decode(CartAddArgs, raw);
        const userId = yield* requireUser(context, args.userId);
        return yield* addLine({ userId, id: args.id, variantId: args.variantId, qty: args.qty });
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
        return yield* removeLine({ userId, id: args.id });
      }).pipe(transient),

    // Recomputes the order from the authoritative cart (args.items only drove
    // the client's optimistic overlay) — replay-as-conflict-resolution.
    "order/place": (raw, _tx, context) =>
      Effect.gen(function* () {
        const args = yield* decode(OrderPlaceArgs, raw);
        const userId = yield* requireUser(context, args.userId);
        return yield* place({ userId, id: args.orderId, createdAt: args.createdAt });
      }).pipe(transient),

    "review/write": (raw, _tx, context) =>
      Effect.gen(function* () {
        const args = yield* decode(ReviewWriteArgs, raw);
        const userId = yield* requireUser(context, args.userId);
        return yield* review({ ...args, userId });
      }).pipe(transient),

    // The graph-derived mutations the façade journals (ADR-0030 §5, #525): the
    // same rules as the named intents above, over the graph row form.
    "reviews/create": (raw, _tx, context) =>
      Effect.gen(function* () {
        const { id, attributes } = yield* decode(ReviewCreateArgs, raw);
        const userId = yield* callerOf(context, attributes.userId);
        return yield* review({ ...attributes, id, userId });
      }).pipe(transient),

    "cartItems/create": (raw, _tx, context) =>
      Effect.gen(function* () {
        const { id, attributes } = yield* decode(CartItemCreateArgs, raw);
        const userId = yield* callerOf(context, attributes.userId);
        return yield* addLine({ userId, id, variantId: attributes.variantId, qty: attributes.qty });
      }).pipe(transient),

    "cartItems/delete": (raw, _tx, context) =>
      Effect.gen(function* () {
        const { id } = yield* decode(CartItemDeleteArgs, raw);
        const userId = yield* callerOf(context, undefined);
        return yield* removeLine({ userId, id });
      }).pipe(transient),

    "orders/create": (raw, _tx, context) =>
      Effect.gen(function* () {
        const { id, attributes } = yield* decode(OrderCreateArgs, raw);
        const userId = yield* callerOf(context, attributes.userId);
        return yield* place({ userId, id, createdAt: attributes.createdAt });
      }).pipe(transient),

    "profile/update": (raw, _tx, context) =>
      Effect.gen(function* () {
        const args = yield* decode(ProfileUpdateArgs, raw);
        const userId = yield* requireUser(context, args.id);
        yield* sql`INSERT OR REPLACE INTO profiles (id, name) VALUES (${userId}, ${args.name})`;
        return [hint("profiles", [userId])];
      }).pipe(transient),
  };
};
