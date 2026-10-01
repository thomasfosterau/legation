/**
 * The commerce server in-process, for the app's own tests: the real stack
 * (`syncLayer` over an in-memory SQLite, the seed, a few private rows for
 * two users) and the JSON:API (`jsonApiLive`) served through a web handler,
 * so a test — or a SvelteKit load pointed at it — issues plain `Request`s.
 * The backend is wrapped to count its calls (`counted.ts`), so "before any
 * backend call" is a fact the derived-read tests can assert.
 */
import { Context, Effect, Layer } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { SqlClient } from "effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { migrate } from "../../server/db.js";
import { jsonApiLive } from "../../server/jsonapi.js";
import { CommerceSync, syncLayer } from "../../server/runtime.js";
import { type Calls, countedBackend } from "./counted.js";

export type Json = any;

export interface World {
  /** `GET` a path of the api as `user` (or anonymously); the parsed body. */
  readonly get: (
    path: string,
    user?: string
  ) => Effect.Effect<{ readonly status: number; readonly body: Json }>;
  /** The web handler behind {@link get}, for a `fetch` stand-in. */
  readonly handler: (request: Request) => Promise<Response>;
  /** How many times the backend was asked to evaluate or fetch rows so far. */
  readonly calls: () => number;
}

/** The seed plus private rows for two users, so scoping has something to hide. */
const seedPrivateRows = (sql: SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO cartItems (id, userId, variantId, qty)
      VALUES ('ci-1', 'u1', 'v-01a', 2), ('ci-2', 'u1', 'v-03a', 1), ('ci-3', 'u2', 'v-02a', 1)`;
    yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
      VALUES ('o-1', 'u1', 'placed', 29800, '2026-07-01T00:00:00Z'),
             ('o-2', 'u1', 'shipped', 12900, '2026-07-02T00:00:00Z'),
             ('o-3', 'u2', 'placed', 9900, '2026-07-03T00:00:00Z')`;
    yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
      VALUES ('o-1-0', 'o-1', 'u1', 'v-01a', 2, 14900), ('o-2-0', 'o-2', 'u1', 'v-03a', 1, 12900),
             ('o-3-0', 'o-3', 'u2', 'v-02a', 1, 9900)`;
    // A second review of p-01, newer than the seed's, so `sort=-createdAt` has an order to show.
    yield* sql`INSERT INTO reviews (id, productId, userId, authorName, rating, body, createdAt)
      VALUES ('r-04', 'p-01', 'u2', 'Edsger', 3, 'Cable is short.', '2026-06-20T08:00:00Z')`;
  });

/** Build the world; scoped — the handler is disposed with the scope. */
export const makeWorld = Effect.gen(function* () {
  const context = yield* Layer.build(
    syncLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  );
  const sql = Context.get(context, SqlClient);
  yield* migrate.pipe(Effect.provideService(SqlClient, sql));
  yield* seedPrivateRows(sql);

  const calls: Calls = { n: 0 };
  const sync = countedBackend(Context.get(context, CommerceSync), calls);
  const app = jsonApiLive.pipe(
    Layer.provide(Layer.succeedContext(Context.add(context, CommerceSync, sync))),
    Layer.provide(HttpServer.layerServices)
  ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose)
  );

  const get: World["get"] = (path, user) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://commerce.test${path}`, {
          headers: {
            accept: "application/vnd.api+json",
            ...(user === undefined ? {} : { "x-commerce-user": user }),
          },
        })
      );
      return { status: response.status, body: (await response.json()) as Json };
    });

  const world: World = { get, handler, calls: () => calls.n };
  return world;
});
