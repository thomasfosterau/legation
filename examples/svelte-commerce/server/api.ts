/**
 * The app's own HTTP API (Effect v4 `HttpApi`) — the write path for
 * everything that is NOT a sync mutator: sign-in/out (the client-group →
 * user binding) and the no-JS add-to-cart form. The SvelteKit process calls
 * these with a derived `HttpApiClient` instead of opening SQLite itself, so
 * every out-of-band write lands in the sync server's process and publishes
 * its invalidation hints straight into the bus (ADR-0019) — live clients get
 * poked immediately instead of waiting for the polling hint source.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { InvalidationBus } from "@legation/effect";
import { bindClientGroup, currentUser } from "./runtime.js";

const SignIn = HttpApiEndpoint.post("signin", "/signin", {
  payload: Schema.Struct({ username: Schema.String, clientGroupId: Schema.String }),
  success: Schema.Struct({ userId: Schema.String }),
  error: HttpApiError.BadRequest,
});

const SignOut = HttpApiEndpoint.post("signout", "/signout", {
  payload: Schema.Struct({ clientGroupId: Schema.String }),
});

const CartAdd = HttpApiEndpoint.post("add", "/add", {
  payload: Schema.Struct({ clientGroupId: Schema.String, variantId: Schema.String }),
  success: Schema.Struct({ id: Schema.String }),
  error: [HttpApiError.Unauthorized, HttpApiError.BadRequest],
});

export const api = HttpApi.make("commerce")
  .add(HttpApiGroup.make("account").add(SignIn, SignOut).prefix("/account"))
  .add(HttpApiGroup.make("cart").add(CartAdd).prefix("/cart"))
  .prefix("/api");

const accountLive = HttpApiBuilder.group(api, "account", (handlers) =>
  handlers
    .handle("signin", ({ payload }) =>
      Effect.gen(function* () {
        const username = payload.username.trim();
        if (username === "") return yield* Effect.fail(new HttpApiError.BadRequest());
        const userId = `u-${username.toLowerCase()}`;
        const sql = yield* SqlClient;
        const bus = yield* InvalidationBus.InvalidationBus;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO profiles (id, name) VALUES (${userId}, ${username})`;
            yield* bindClientGroup(payload.clientGroupId, userId);
          })
        ).pipe(Effect.orDie);
        yield* bus.publish([{ collection: "profiles", ids: [userId] }]);
        return { userId };
      })
    )
    .handle("signout", ({ payload }) =>
      bindClientGroup(payload.clientGroupId, undefined).pipe(Effect.orDie)
    )
);

const cartLive = HttpApiBuilder.group(api, "cart", (handlers) =>
  handlers.handle("add", ({ payload }) =>
    Effect.gen(function* () {
      const userId = yield* currentUser(payload.clientGroupId).pipe(Effect.orDie);
      if (userId === undefined) return yield* Effect.fail(new HttpApiError.Unauthorized());
      const sql = yield* SqlClient;
      const bus = yield* InvalidationBus.InvalidationBus;
      const variant = yield* sql<{
        id: string;
      }>`SELECT id FROM variants WHERE id = ${payload.variantId}`.pipe(Effect.orDie);
      if (variant.length === 0) return yield* Effect.fail(new HttpApiError.BadRequest());
      const id = `ci-${crypto.randomUUID()}`;
      yield* sql`INSERT INTO cartItems (id, userId, variantId, qty)
        VALUES (${id}, ${userId}, ${payload.variantId}, 1)`.pipe(Effect.orDie);
      yield* bus.publish([{ collection: "cartItems", ids: [id] }]);
      return { id };
    })
  )
);

/** Registers the API's routes on the ambient `HttpRouter`. */
export const apiLive = HttpApiBuilder.layer(api).pipe(
  Layer.provide(accountLive),
  Layer.provide(cartLive)
);
