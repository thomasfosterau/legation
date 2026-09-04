/**
 * RestHandlers tests (#163): derived `list` / `get` handlers over the
 * engine's read path — `MemoryBackend` under an auth policy with a private
 * collection — served in-process through effect-jsonapi's `Endpoint.list` /
 * `Endpoint.get` behind `HttpApiBuilder`. The tier is checked for what it
 * derives: the policy's scoping (no `WHERE userId` anywhere), the codec's
 * 400 before any backend call, `fields[]` as a projection over full rows,
 * `Subset.apply`'s order and cursor window, and the two-phase include.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  ApiError,
  Endpoint,
  Group,
  Middleware,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";
import {
  Authorization,
  type Backend,
  Edge,
  MemoryBackend,
  Node,
  Predicate,
} from "@legation/effect";
import * as JsonApiQuery from "../JsonApiQuery.js";
import * as RestHandlers from "../RestHandlers.js";

// ─── The node graph ──────────────────────────────────────────────────────────

const categories = Node.make("categories", { attributes: { name: Schema.String } });
const products = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    variants: Edge.many("variants", { inverse: "product" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
  filterable: { priceCents: ["gt", "lt"] },
  sortable: ["name", "priceCents"],
});
const variants = Node.make("variants", {
  attributes: { sku: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const reviews = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const cartItems = Node.make("cartItems", {
  attributes: { userId: Schema.String, qty: Schema.Number },
  edges: { variant: Edge.one("variants", { via: "variantId" }) },
  filterable: { userId: ["eq"] },
});
const nodes = Node.registry([categories, products, variants, reviews, cartItems]);

/** Identity-scoped filter (ADR-0015): signed-in users see their rows, anonymous an empty allow-set. */
const scopedBy =
  (field: string): Authorization.AuthFilter =>
  (context) =>
    Effect.succeed(
      typeof context.identity === "string"
        ? Predicate.eq(field, context.identity)
        : Predicate.isIn(field, [])
    );

const policy = Authorization.policy(
  {
    categories: Authorization.allowAll,
    products: Authorization.allowAll,
    variants: Authorization.allowAll,
    reviews: Authorization.allowAll,
    cartItems: scopedBy("userId"),
  },
  { collections: nodes.collections }
);

// ─── The resources the endpoints are declared with ──────────────────────────
//
// A sparse fieldset leaves attributes out of the resource object, so a
// resource that serves `fields[]` declares them `resource: "optional"`; a
// required attribute would fail the endpoint's success encoder (a 400 from
// the response side, not the request side).

const Category = Resource.make("categories", { attributes: { name: Schema.String } });
const Variant = Resource.make("variants", {
  attributes: { sku: Resource.attribute(Schema.String, { resource: "optional" }) },
});
const Review = Resource.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
});
const Product = Resource.make("products", {
  attributes: {
    name: Resource.attribute(Schema.String, { resource: "optional" }),
    priceCents: Resource.attribute(Schema.Number, { resource: "optional" }),
  },
  relationships: {
    category: Relationship.one(() => Category),
    variants: Relationship.many(() => Variant),
    reviews: Relationship.paginated(() => Review),
  },
});
const CartItem = Resource.make("cartItems", {
  attributes: { userId: Schema.String, qty: Schema.Number },
  relationships: { variant: Relationship.one(() => Variant) },
});

class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
}) {}

const api = HttpApi.make("shop")
  .add(
    Group.make(
      Product,
      Endpoint.list(Product, {
        include: true,
        fields: true,
        sort: ["name", "priceCents"],
        page: JsonApiQuery.PageWindow,
      }),
      Endpoint.get(Product, { include: true, fields: true, errors: [NotFound] })
    )
  )
  .add(Group.make(CartItem, Endpoint.list(CartItem, { include: true, errors: [NotFound] })))
  .prefix("/api");

// ─── The world: a seeded backend, the derived handlers, an in-process server ──

interface Seed {
  readonly collection: string;
  readonly id: string;
  readonly value: unknown;
}

const seeds: ReadonlyArray<Seed> = [
  { collection: "categories", id: "c-audio", value: { id: "c-audio", name: "Audio" } },
  {
    collection: "products",
    id: "p-1",
    value: { id: "p-1", categoryId: "c-audio", name: "Desk", priceCents: 300 },
  },
  {
    collection: "products",
    id: "p-2",
    value: { id: "p-2", categoryId: "c-audio", name: "Lamp", priceCents: 100 },
  },
  {
    collection: "products",
    id: "p-3",
    value: { id: "p-3", categoryId: "c-audio", name: "Chair", priceCents: 200 },
  },
  { collection: "variants", id: "v-1", value: { id: "v-1", productId: "p-1", sku: "DSK-1" } },
  { collection: "variants", id: "v-2", value: { id: "v-2", productId: "p-1", sku: "DSK-2" } },
  { collection: "variants", id: "v-3", value: { id: "v-3", productId: "p-2", sku: "LMP-1" } },
  {
    collection: "reviews",
    id: "r-1",
    value: { id: "r-1", productId: "p-1", body: "Solid", createdAt: "2026-01-01T00:00:00.000Z" },
  },
  {
    collection: "reviews",
    id: "r-2",
    value: { id: "r-2", productId: "p-1", body: "Sturdy", createdAt: "2026-02-01T00:00:00.000Z" },
  },
  {
    collection: "cartItems",
    id: "ci-1",
    value: { id: "ci-1", userId: "u1", variantId: "v-1", qty: 2 },
  },
  {
    collection: "cartItems",
    id: "ci-2",
    value: { id: "ci-2", userId: "u2", variantId: "v-3", qty: 1 },
  },
];

const makeWorld = Effect.gen(function* () {
  const memory = yield* MemoryBackend.make({
    "seed/put": (args, writer) => {
      const seed = args as Seed;
      return writer.put(seed.collection, seed.id, seed.value);
    },
  });
  yield* memory.applyMutations(
    { clientGroupId: "seed" },
    seeds.map((seed, index) => ({
      clientId: "seed",
      mutationId: index + 1,
      mutator: "seed/put",
      args: seed,
      createdAt: 0,
    }))
  );
  // Count backend calls, so "before any backend call" is a fact, not a hope.
  let calls = 0;
  const backend: Backend.Backend = {
    ...memory,
    evaluate: (context, subset) => {
      calls++;
      return memory.evaluate(context, subset);
    },
    getRows: (context, collection, ids) => {
      calls++;
      return memory.getRows(context, collection, ids);
    },
  };
  const rest = RestHandlers.make({
    nodes,
    backend,
    policy,
    // The identity seam: a header the app trusts (a test stand-in for a verified session).
    context: (request) =>
      Effect.succeed({
        clientGroupId: "http",
        ...(typeof request.headers["x-user"] === "string"
          ? { identity: request.headers["x-user"] }
          : {}),
      }),
    prefix: "/api",
  });
  const productsLive = HttpApiBuilder.group(api, "products", (handlers) =>
    handlers
      .handle("list", rest.list(Product))
      .handle("get", rest.get(Product, { notFound: () => new NotFound() }))
  );
  const cartItemsLive = HttpApiBuilder.group(api, "cartItems", (handlers) =>
    handlers.handle("list", rest.list(CartItem))
  );
  const app = HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      Layer.mergeAll(productsLive, cartItemsLive).pipe(Layer.provide(Middleware.layer))
    ),
    Layer.provide(Middleware.layer),
    Layer.provide(HttpServer.layerServices)
  ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose)
  );
  const fetch = (path: string, user?: string) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://shop.test${path}`, {
          headers: {
            accept: "application/vnd.api+json",
            ...(user === undefined ? {} : { "x-user": user }),
          },
        })
      );
      return { status: response.status, body: (await response.json()) as any };
    });
  return { rest, fetch, calls: () => calls };
});

/** A request value for calling a derived handler directly. */
const request = (path: string, user?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://shop.test${path}`, {
      headers: user === undefined ? {} : { "x-user": user },
    })
  );

const ids = (resources: ReadonlyArray<{ readonly id: string }>) =>
  resources.map((resource) => resource.id);

describe("RestHandlers over the read path", () => {
  it.effect(
    "lists a collection in Subset.apply's order with one-edge linkage and many-edge linkage",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fetch } = yield* makeWorld;
          const { status, body } = yield* fetch("/api/products?sort=name");
          expect(status).toBe(200);
          expect(ids(body.data)).toEqual(["p-3", "p-1", "p-2"]);
          expect(body.data[1]).toEqual({
            type: "products",
            id: "p-1",
            attributes: { name: "Desk", priceCents: 300 },
            relationships: {
              category: { data: { type: "categories", id: "c-audio" } },
              variants: {
                data: [
                  { type: "variants", id: "v-1" },
                  { type: "variants", id: "v-2" },
                ],
              },
              reviews: {
                links: {
                  self: "/api/products/p-1/relationships/reviews",
                  related: "/api/products/p-1/reviews",
                },
              },
            },
          });
          // Linkage was resolved, but nothing was asked to be included.
          expect(body).not.toHaveProperty("included");
          expect(body.links).toEqual({ self: "/api/products?sort=name" });
        })
      )
  );

  it.effect("resolves includes in two phases and compounds them, filters through the grammar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fetch } = yield* makeWorld;
        const { body } = yield* fetch(
          "/api/products?include=variants,category&filter[priceCents][gt]=150&sort=-priceCents"
        );
        expect(ids(body.data)).toEqual(["p-1", "p-3"]);
        expect(body.included.map((r: any) => `${r.type}/${r.id}`)).toEqual([
          "categories/c-audio",
          "variants/v-1",
          "variants/v-2",
        ]);
        expect(body.links).toEqual({
          self: "/api/products?include=category%2Cvariants&filter[priceCents][gt]=150&sort=-priceCents",
        });
      })
    )
  );

  it.effect(
    "pages by cursor: links.next carries page[after] at the last id, a short page has none",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fetch } = yield* makeWorld;
          const first = yield* fetch("/api/products?sort=name&page[limit]=2");
          expect(ids(first.body.data)).toEqual(["p-3", "p-1"]);
          expect(first.body.links.next).toBe(
            "/api/products?sort=name&page[limit]=2&page[after]=p-1"
          );
          const second = yield* fetch(first.body.links.next);
          expect(ids(second.body.data)).toEqual(["p-2"]);
          expect(second.body.links).toEqual({
            self: "/api/products?sort=name&page[limit]=2&page[after]=p-1",
          });
        })
      )
  );

  it.effect(
    "projects fields[type] at serialisation while the backend was asked for full rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fetch } = yield* makeWorld;
          const { status, body } = yield* fetch(
            "/api/products?fields[products]=name&include=variants&fields[variants]="
          );
          expect(status).toBe(200);
          expect(body.data.every((r: any) => Object.keys(r.attributes).join() === "name")).toBe(
            true
          );
          // Linkage survives the projection; the rows behind it were full.
          expect(body.data[0].relationships.category.data.id).toBe("c-audio");
          expect(body.included.every((r: any) => Object.keys(r.attributes).length === 0)).toBe(
            true
          );
        })
      )
  );

  it.effect(
    "gets one resource as filter[id], first 1, and 404s through the endpoint's own error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fetch } = yield* makeWorld;
          const found = yield* fetch("/api/products/p-2?include=variants");
          expect(found.status).toBe(200);
          expect(found.body.data.id).toBe("p-2");
          expect(found.body.included.map((r: any) => r.id)).toEqual(["v-3"]);
          expect(found.body.links).toEqual({
            self: "/api/products?include=variants&filter[id]=p-2&page[limit]=1",
          });
          const missing = yield* fetch("/api/products/p-9");
          expect(missing.status).toBe(404);
          expect(missing.body.errors[0]).toMatchObject({ status: "404", code: "not_found" });
        })
      )
  );

  it.effect(
    "scopes private collections through the auth policy: anonymous is empty, a user sees their rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fetch } = yield* makeWorld;
          const anonymous = yield* fetch("/api/cartItems");
          expect(anonymous.status).toBe(200);
          expect(anonymous.body.data).toEqual([]);
          const mine = yield* fetch("/api/cartItems?include=variant", "u1");
          expect(ids(mine.body.data)).toEqual(["ci-1"]);
          expect(mine.body.included.map((r: any) => r.id)).toEqual(["v-1"]);
          // A filter for someone else's rows only narrows what the policy allows.
          const theirs = yield* fetch("/api/cartItems?filter[userId]=u2", "u1");
          expect(theirs.body.data).toEqual([]);
        })
      )
  );

  it.effect(
    "answers a filter over an undeclared field with the codec's 400 before any backend call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { rest, calls } = yield* makeWorld;
          const before = calls();
          const response = yield* rest.list(Product)({
            request: request("/api/products?filter[name]=Desk"),
          });
          expect(HttpServerResponse.isHttpServerResponse(response)).toBe(true);
          const served = HttpServerResponse.toWeb(
            response as HttpServerResponse.HttpServerResponse
          );
          expect(served.status).toBe(400);
          expect(served.headers.get("content-type")).toContain("application/vnd.api+json");
          const body = (yield* Effect.promise(() => served.json())) as any;
          expect(body.errors[0]).toMatchObject({
            status: "400",
            source: { parameter: "filter[name]" },
          });
          expect(calls()).toBe(before);
        })
      )
  );

  it.effect(
    "rejects an undeclared include and a single-resource request with a listing parameter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { rest } = yield* makeWorld;
          const includes = yield* rest.list(Product)({
            request: request("/api/products?include=owner"),
          });
          const includeBody = (yield* Effect.promise(() =>
            HttpServerResponse.toWeb(includes as HttpServerResponse.HttpServerResponse).json()
          )) as any;
          expect(includeBody.errors[0].source).toEqual({ parameter: "include" });
          const sorted = yield* rest.get(Product, { notFound: () => new NotFound() })({
            params: { id: "p-1" },
            request: request("/api/products/p-1?sort=name"),
          });
          const sortedBody = (yield* Effect.promise(() =>
            HttpServerResponse.toWeb(sorted as HttpServerResponse.HttpServerResponse).json()
          )) as any;
          expect(sortedBody.errors[0].source).toEqual({ parameter: "sort" });
        })
      )
  );

  it.effect("includes a paginated edge in its declared order, linkage beside the links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { rest } = yield* makeWorld;
        const document = (yield* rest.list(Product)({
          request: request("/api/products?include=reviews&filter[priceCents][gt]=250"),
        })) as any;
        expect(document.data.map((r: any) => r.id)).toEqual(["p-1"]);
        // The edge's own order (`-createdAt`), not the rows' storage order.
        expect(document.data[0].relationships.reviews).toEqual({
          links: {
            self: "/api/products/p-1/relationships/reviews",
            related: "/api/products/p-1/reviews",
          },
          data: [
            { type: "reviews", id: "r-2" },
            { type: "reviews", id: "r-1" },
          ],
        });
        expect(document.included.map((r: any) => r.id)).toEqual(["r-2", "r-1"]);
      })
    )
  );

  it.effect("answers a collection the policy does not declare with a 403", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { rest } = yield* makeWorld;
        const Secret = Resource.make("secrets", { attributes: { name: Schema.String } });
        const secrets = Node.make("secrets", { attributes: { name: Schema.String } });
        const graph = Node.registry([secrets]);
        const closed = RestHandlers.make({
          nodes: graph,
          backend: (yield* MemoryBackend.make({})) as Backend.Backend,
          policy: Authorization.policy({}, { collections: graph.collections }),
          context: () => Effect.succeed({ clientGroupId: "http" }),
        });
        const response = yield* closed.list(Secret)({ request: request("/secrets") });
        const served = HttpServerResponse.toWeb(response as HttpServerResponse.HttpServerResponse);
        expect(served.status).toBe(403);
        expect(((yield* Effect.promise(() => served.json())) as any).errors[0].code).toBe(
          "forbidden"
        );
        // And a resource without a node is a definition-time defect.
        expect(() => rest.list(Secret)).toThrow(/no node "secrets"/);
      })
    )
  );
});
