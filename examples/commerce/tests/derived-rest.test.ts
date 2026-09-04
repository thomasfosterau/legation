/**
 * The derived REST handlers against the commerce server (#163): every
 * hand-written `list` / `get` endpoint in `server/jsonapi.ts` beside its
 * derivation over the same tables — `RestHandlers` running ADR-0025's read
 * (`Query.plan` → `authorize` → `SqlBackend.evaluate` + `getRows`) under
 * the app's own `authPolicy`, serialised by `DocumentWriter`. The two are
 * served in-process and compared on the seed data, modulo `links` and the
 * ways `server/resources.ts` and `src/lib/domain.ts` declare the domain
 * differently (listed at {@link normalise}). #165 swaps the hand-written
 * handlers for these; nothing here replaces them.
 *
 * Beside the comparison, the tier's own promises: an anonymous request to a
 * private collection is an empty collection (`list`) or a 404 (`get`) — the
 * policy's empty allow-set, no `WHERE userId` anywhere on the derived path;
 * `fields[products]=name` projects at serialisation over full rows; a filter
 * over an undeclared field is the codec's 400 with `source.parameter`
 * before any backend call.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Backend } from "@legation/effect";
import { RestHandlers } from "@legation/jsonapi";
import { nodes } from "../src/lib/domain.js";
import { migrate } from "../server/db.js";
import { jsonApiLive, NotFound } from "../server/jsonapi.js";
import { CartItem, Category, Order, OrderItem, Product, Review } from "../server/resources.js";
import { authPolicy, CommerceSync, syncLayer } from "../server/runtime.js";

// ─── The derived api: the same routes, plain endpoints, derived handlers ────
//
// Plain `HttpApiEndpoint`s with an open success schema, so the comparison is
// about the documents the derivation writes and nothing about how
// `server/resources.ts` would encode them (its declarations differ from the
// node graph — see `normalise`). `/orders/:id` has no hand-written twin; it
// is here for the private `get` promise.

const idParam = { params: Schema.Struct({ id: Schema.String }), error: NotFound.wire };
const open = { success: Schema.Unknown };
const derivedApi = HttpApi.make("derived")
  .add(
    HttpApiGroup.make("catalog")
      .add(HttpApiEndpoint.get("categories", "/categories", open))
      .add(HttpApiEndpoint.get("products", "/products", open))
      .add(HttpApiEndpoint.get("product", "/products/:id", { ...idParam, ...open }))
      .add(HttpApiEndpoint.get("reviews", "/reviews", open))
  )
  .add(
    HttpApiGroup.make("account")
      .add(HttpApiEndpoint.get("cartItems", "/cartItems", open))
      .add(HttpApiEndpoint.get("orders", "/orders", open))
      .add(HttpApiEndpoint.get("order", "/orders/:id", { ...idParam, ...open }))
      .add(HttpApiEndpoint.get("orderItems", "/orderItems", open))
  )
  .prefix("/jsonapi");

const notFound = { notFound: () => new NotFound() };

const derivedLive = (rest: RestHandlers.RestHandlers) =>
  Layer.mergeAll(
    HttpApiBuilder.group(derivedApi, "catalog", (handlers) =>
      handlers
        .handle("categories", rest.list(Category))
        .handle("products", rest.list(Product))
        .handle("product", rest.get(Product, notFound))
        .handle("reviews", rest.list(Review))
    ),
    HttpApiBuilder.group(derivedApi, "account", (handlers) =>
      handlers
        .handle("cartItems", rest.list(CartItem))
        .handle("orders", rest.list(Order))
        .handle("order", rest.get(Order, notFound))
        .handle("orderItems", rest.list(OrderItem))
    )
  );

// ─── The world ───────────────────────────────────────────────────────────────

type Json = any;

const makeWorld = Effect.gen(function* () {
  const context = yield* Layer.build(
    syncLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  );
  const sql = Context.get(context, SqlClient);
  yield* migrate.pipe(Effect.provideService(SqlClient, sql));
  // Private rows for two users, so scoping has something to hide.
  yield* sql`INSERT INTO cartItems (id, userId, variantId, qty)
    VALUES ('ci-1', 'u1', 'v-01a', 2), ('ci-2', 'u1', 'v-03a', 1), ('ci-3', 'u2', 'v-02a', 1)`;
  yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
    VALUES ('o-1', 'u1', 'placed', 29800, '2026-07-01T00:00:00Z'),
           ('o-2', 'u1', 'shipped', 12900, '2026-07-02T00:00:00Z'),
           ('o-3', 'u2', 'placed', 9900, '2026-07-03T00:00:00Z')`;
  yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
    VALUES ('o-1-0', 'o-1', 'u1', 'v-01a', 2, 14900), ('o-2-0', 'o-2', 'u1', 'v-03a', 1, 12900),
           ('o-3-0', 'o-3', 'u2', 'v-02a', 1, 9900)`;

  const { backend: sqlBackend } = Context.get(context, CommerceSync);
  let calls = 0;
  const backend: Backend.Backend = {
    ...sqlBackend,
    evaluate: (ctx, subset) => {
      calls++;
      return sqlBackend.evaluate(ctx, subset);
    },
    getRows: (ctx, collection, ids) => {
      calls++;
      return sqlBackend.getRows(ctx, collection, ids);
    },
  };
  const rest = RestHandlers.make({
    nodes,
    backend,
    policy: authPolicy,
    // The same trust boundary as `server/jsonapi.ts`: the Kit process's verdict as a header.
    context: (request) => {
      const user = request.headers["x-commerce-user"];
      return Effect.succeed({
        clientGroupId: "http",
        ...(typeof user === "string" && user.length > 0 ? { identity: user } : {}),
      });
    },
    prefix: "/jsonapi",
  });

  const serve = <E>(app: Layer.Layer<never, E, HttpRouter.HttpRouter>) =>
    Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose)
    ).pipe(
      Effect.map(
        ({ handler }) =>
          (path: string, user?: string) =>
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
            })
      )
    );

  const handWritten = yield* serve(
    jsonApiLive.pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(HttpServer.layerServices)
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter>
  );
  const derived = yield* serve(
    HttpApiBuilder.layer(derivedApi).pipe(
      Layer.provide(derivedLive(rest)),
      Layer.provide(HttpServer.layerServices)
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter>
  );
  return { handWritten, derived, calls: () => calls };
});

// ─── Normalisation: links, and where the two declarations of the domain differ ──
//
// `server/resources.ts` (the REST contract) and `src/lib/domain.ts` (the
// node graph) describe the same tables differently, and the derivation
// speaks the node graph's dialect:
//
// 1. `userId` is an attribute of the reviews / cartItems / orders /
//    orderItems nodes (the sync tier ships it), and the REST resources do
//    not expose it.
// 2. A variant's `productId` is a `one` edge on the node (`product`) and a
//    plain attribute on the resource (the resource graph is acyclic).
// 3. The products node has a paginated `reviews` edge and the orders node
//    a `many` `items` edge; the resources declare neither.
// 4. `links` — `self` / `next` and the paginated edge's links — which the
//    hand-written handlers never set.
//
// Each is a declaration gap for #165 to close, not a behaviour of the read
// path; the normaliser removes exactly these.

const normaliseResource = (resource: Json): Json => {
  const { userId: _userId, ...attributes } = resource.attributes ?? {};
  const relationships: Record<string, Json> = { ...(resource.relationships ?? {}) };
  delete relationships["reviews"];
  delete relationships["items"];
  if (resource.type === "variants" && relationships["product"] !== undefined) {
    attributes.productId = relationships["product"].data.id;
    delete relationships["product"];
  }
  return {
    type: resource.type,
    id: resource.id,
    attributes,
    ...(Object.keys(relationships).length === 0 ? {} : { relationships }),
  };
};

const normalise = (document: Json): Json => ({
  data: Array.isArray(document.data)
    ? document.data.map(normaliseResource)
    : normaliseResource(document.data),
  ...(document.included === undefined ? {} : { included: document.included.map(normaliseResource) }),
});

/** The hand-written handlers order implicitly; the derived ones order by the URL. */
const routes: ReadonlyArray<{
  readonly name: string;
  readonly handWritten: string;
  readonly derived: string;
  readonly user?: string;
}> = [
  { name: "categories", handWritten: "/jsonapi/categories", derived: "/jsonapi/categories?sort=name" },
  { name: "products", handWritten: "/jsonapi/products", derived: "/jsonapi/products?sort=id" },
  {
    name: "products in a category, with variants",
    handWritten: "/jsonapi/products?filter[categoryId]=c-keyboards&include=variants",
    derived: "/jsonapi/products?filter[categoryId]=c-keyboards&include=variants&sort=id",
  },
  {
    name: "one product with variants",
    handWritten: "/jsonapi/products/p-01?include=variants",
    derived: "/jsonapi/products/p-01?include=variants",
  },
  {
    name: "reviews of a product",
    handWritten: "/jsonapi/reviews?filter[productId]=p-03",
    derived: "/jsonapi/reviews?filter[productId]=p-03&sort=-createdAt",
  },
  {
    name: "a user's cart with variants",
    handWritten: "/jsonapi/cartItems?include=variant",
    derived: "/jsonapi/cartItems?include=variant",
    user: "u1",
  },
  {
    name: "a user's orders",
    handWritten: "/jsonapi/orders",
    derived: "/jsonapi/orders?sort=-createdAt",
    user: "u1",
  },
  {
    name: "a user's order items",
    handWritten: "/jsonapi/orderItems",
    derived: "/jsonapi/orderItems",
    user: "u1",
  },
];

describe("derived REST handlers over the commerce server", () => {
  for (const route of routes) {
    it.effect(`${route.name}: the derived document equals the hand-written one modulo links`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handWritten, derived } = yield* makeWorld;
          const expected = yield* handWritten(route.handWritten, route.user);
          const actual = yield* derived(route.derived, route.user);
          expect(expected.status).toBe(200);
          expect(actual.status).toBe(200);
          expect(actual.body.data).not.toEqual([]);
          expect(normalise(actual.body)).toEqual(normalise(expected.body));
        })
      )
    );
  }

  it.effect("scopes private collections by the auth policy: anonymous is empty, or 404 for a get", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { derived } = yield* makeWorld;
        for (const path of ["/jsonapi/cartItems", "/jsonapi/orders", "/jsonapi/orderItems"]) {
          const { status, body } = yield* derived(path);
          expect(status).toBe(200);
          expect(body.data).toEqual([]);
        }
        const anonymous = yield* derived("/jsonapi/orders/o-1");
        expect(anonymous.status).toBe(404);
        expect(anonymous.body.errors[0]).toMatchObject({ status: "404", code: "not_found" });
        const someoneElse = yield* derived("/jsonapi/orders/o-1", "u2");
        expect(someoneElse.status).toBe(404);
        const owner = yield* derived("/jsonapi/orders/o-1", "u1");
        expect(owner.status).toBe(200);
        expect(owner.body.data.id).toBe("o-1");
        // A filter for another user's rows only narrows what the policy allows.
        const narrowed = yield* derived("/jsonapi/orders?filter[userId]=u2", "u1");
        expect(narrowed.body.data).toEqual([]);
      })
    )
  );

  it.effect("fields[products]=name returns only name while the backend was asked for full rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { derived } = yield* makeWorld;
        const { body } = yield* derived("/jsonapi/products?fields[products]=name&sort=id");
        expect(body.data).toHaveLength(6);
        for (const product of body.data) {
          expect(Object.keys(product.attributes)).toEqual(["name"]);
          // Linkage is read off the full row, never projected away.
          expect(product.relationships.category.data.type).toBe("categories");
          expect(product.relationships.variants.data.length).toBeGreaterThan(0);
        }
        expect(body.links.self).toBe("/jsonapi/products?fields[products]=name&sort=id");
      })
    )
  );

  it.effect("a filter over an undeclared field is the codec's 400 with source.parameter, before any backend call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { derived, calls } = yield* makeWorld;
        const before = calls();
        const { status, body } = yield* derived("/jsonapi/products?filter[description]=oak");
        expect(status).toBe(400);
        expect(body.errors[0]).toMatchObject({
          status: "400",
          code: "bad_request",
          source: { parameter: "filter[description]" },
        });
        expect(calls()).toBe(before);
      })
    )
  );

  it.effect("pages by Subset.apply's cursor window: links.next continues after the last id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { derived } = yield* makeWorld;
        const first = yield* derived("/jsonapi/products?sort=id&page[limit]=4");
        expect(first.body.data.map((p: Json) => p.id)).toEqual(["p-01", "p-02", "p-03", "p-04"]);
        expect(first.body.links.next).toBe("/jsonapi/products?sort=id&page[limit]=4&page[after]=p-04");
        const second = yield* derived(first.body.links.next);
        expect(second.body.data.map((p: Json) => p.id)).toEqual(["p-05", "p-06"]);
        expect(second.body.links.next).toBeUndefined();
      })
    )
  );
});
