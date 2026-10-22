/**
 * RestHandlers tests (#163): derived `list` / `get` handlers over the
 * engine's read path — `MemoryBackend` under an auth policy with a private
 * collection — served in-process through effect-jsonapi's `Endpoint.list` /
 * `Endpoint.get` behind `HttpApiBuilder`, every document passing the
 * endpoint's success encoder. The tier is checked for what it derives: the
 * policy's scoping (no `WHERE userId` anywhere), the codec's 400 before any
 * backend call, `fields[]` as a projection over full rows, `Subset.apply`'s
 * order and cursor window, the two-phase include, and linkage that follows
 * the resource's declaration — on the primary and the included resources,
 * for a paginated node edge under either declaration, and never for a
 * collection the resource does not declare.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
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
} from "@thomasfosterau/legation-effect";
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
  edges: {
    product: Edge.one("products", { via: "productId" }),
    offers: Edge.many("offers", { inverse: "variant" }),
  },
});
const offers = Node.make("offers", {
  attributes: { priceCents: Schema.Number },
  edges: { variant: Edge.one("variants", { via: "variantId" }) },
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
// A node with a `many` edge into a collection no resource declares.
const sellers = Node.make("sellers", {
  attributes: { name: Schema.String },
  edges: { contracts: Edge.many("contracts", { inverse: "seller" }) },
});
const contracts = Node.make("contracts", {
  attributes: { terms: Schema.String },
  edges: { seller: Edge.one("sellers", { via: "sellerId" }) },
});
const nodes = Node.registry([
  categories,
  products,
  variants,
  offers,
  reviews,
  cartItems,
  sellers,
  contracts,
]);

/** Identity-scoped filter (ADR-0015): signed-in users see their rows, anonymous an empty allow-set. */
const scopedBy =
  (field: string): Authorization.AuthFilter =>
  (context) =>
    Effect.succeed(
      P.isString(context.identity)
        ? Predicate.eq(field, context.identity)
        : Predicate.isIn(field, [])
    );

const catalog = {
  products: Authorization.allowAll,
  variants: Authorization.allowAll,
  offers: Authorization.allowAll,
  reviews: Authorization.allowAll,
  sellers: Authorization.allowAll,
  cartItems: scopedBy("userId"),
};

/** Every collection declared; `contracts` deliberately absent (no resource names it). */
const fullPolicy = Authorization.policy(
  { ...catalog, categories: Authorization.allowAll },
  { collections: nodes.collections }
);

/** `categories` absent too: what a request that names it, and one that does not, get. */
const narrowPolicy = Authorization.policy(catalog, { collections: nodes.collections });

// ─── The resources the endpoints are declared with ──────────────────────────
//
// A sparse fieldset leaves attributes out of the resource object, so a
// resource that serves `fields[]` declares them `resource: "optional"`; a
// required attribute would fail the endpoint's success encoder (a 400 from
// the response side, not the request side).

const Category = Resource.make("categories", { attributes: { name: Schema.String } });
const Offer = Resource.make("offers", { attributes: { priceCents: Schema.Number } });
const Variant = Resource.make("variants", {
  attributes: { sku: Resource.attribute(Schema.String, { resource: "optional" }) },
  relationships: { offers: Relationship.many(() => Offer) },
});
const Review = Resource.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
});
/** The paginated `reviews` edge declared `many`: linkage and `include=` both served. */
const Product = Resource.make("products", {
  attributes: {
    name: Resource.attribute(Schema.String, { resource: "optional" }),
    priceCents: Resource.attribute(Schema.Number, { resource: "optional" }),
  },
  relationships: {
    category: Relationship.one(() => Category),
    variants: Relationship.many(() => Variant),
    reviews: Relationship.many(() => Review),
  },
});
/** The same node with `reviews` declared `paginated`: links only, no `include=`. */
const PagedProduct = Resource.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
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
/** Declares no relationships: the node's `contracts` edge is nobody's business. */
const Seller = Resource.make("sellers", { attributes: { name: Schema.String } });

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
  .add(
    Group.make(
      "paged",
      Endpoint.list(PagedProduct, { path: "/paged/products", include: true }),
      Endpoint.get(PagedProduct, {
        path: "/paged/products/:id",
        include: true,
        errors: [NotFound],
      })
    )
  )
  .add(Group.make(CartItem, Endpoint.list(CartItem, { include: true })))
  .add(Group.make(Seller, Endpoint.list(Seller)))
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
  { collection: "offers", id: "of-1", value: { id: "of-1", variantId: "v-1", priceCents: 290 } },
  { collection: "offers", id: "of-2", value: { id: "of-2", variantId: "v-1", priceCents: 280 } },
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
  { collection: "sellers", id: "s-1", value: { id: "s-1", name: "Acme" } },
  { collection: "contracts", id: "k-1", value: { id: "k-1", sellerId: "s-1", terms: "net 30" } },
];

const makeWorld = (policy: Authorization.AuthPolicy = fullPolicy) =>
  Effect.gen(function* () {
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
          ...(P.isString(request.headers["x-user"]) ? { identity: request.headers["x-user"] } : {}),
        }),
      prefix: "/api",
    });
    const groups = Layer.mergeAll(
      HttpApiBuilder.group(api, "products", (handlers) =>
        handlers
          .handle("list", rest.list(Product))
          .handle("get", rest.get(Product, { notFound: () => new NotFound() }))
      ),
      HttpApiBuilder.group(api, "paged", (handlers) =>
        handlers
          .handle("list", rest.list(PagedProduct))
          .handle("get", rest.get(PagedProduct, { notFound: () => new NotFound() }))
      ),
      HttpApiBuilder.group(api, "cartItems", (handlers) =>
        handlers.handle("list", rest.list(CartItem))
      ),
      HttpApiBuilder.group(api, "sellers", (handlers) => handlers.handle("list", rest.list(Seller)))
    );
    const app = HttpApiBuilder.layer(api).pipe(
      Layer.provide(groups.pipe(Layer.provide(Middleware.layer))),
      Layer.provide(Middleware.layer),
      Layer.provide(HttpServer.layerServices)
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose)
    );
    const getDocument = (path: string, user?: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://shop.test${path}`, {
            headers: {
              accept: "application/vnd.api+json",
              ...(user === undefined ? {} : { "x-user": user }),
            },
          })
        );
        // oxlint-disable-next-line effect/avoid-any -- the tests read the served JSON:API documents structurally (`data` a list or one resource, `errors`, `included`, `links.next`) across ~40 assertions; typing the body would mean rewriting each assertion, and the endpoint's own encoder already checks the document shape
        return { status: response.status, body: (await response.json()) as any };
      });
    return { rest, getDocument, calls: () => calls };
  });

const ids = (resources: ReadonlyArray<{ readonly id: string }>) =>
  resources.map((resource) => resource.id);

const reviewLinks = (id: string) => ({
  self: `/api/products/${id}/relationships/reviews`,
  related: `/api/products/${id}/reviews`,
});

describe("RestHandlers over the read path", () => {
  it.effect(
    "lists a collection in Subset.apply's order with every declared relationship's linkage",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { getDocument } = yield* makeWorld();
          const { status, body } = yield* getDocument("/api/products?sort=name");
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
              // The paginated node edge under a `many` declaration: links, and
              // its rows' linkage in the edge's declared order (`-createdAt`).
              reviews: {
                links: reviewLinks("p-1"),
                data: [
                  { type: "reviews", id: "r-2" },
                  { type: "reviews", id: "r-1" },
                ],
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
        const { getDocument } = yield* makeWorld();
        const { status, body } = yield* getDocument(
          "/api/products?include=variants,category&filter[priceCents][gt]=150&sort=-priceCents"
        );
        expect(status).toBe(200);
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

  it.effect("gives included resources the linkage their own resource declares", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { getDocument } = yield* makeWorld();
        // An included variant declares `offers: many`, so it must carry it.
        const cart = yield* getDocument("/api/cartItems?include=variant", "u1");
        expect(cart.status).toBe(200);
        expect(cart.body.included).toEqual([
          {
            type: "variants",
            id: "v-1",
            attributes: { sku: "DSK-1" },
            relationships: {
              offers: {
                data: [
                  { type: "offers", id: "of-1" },
                  { type: "offers", id: "of-2" },
                ],
              },
            },
          },
        ]);
        // A parent with no edge rows still carries the relationship, empty.
        const bare = yield* getDocument("/api/products/p-2?include=variants");
        expect(bare.status).toBe(200);
        expect(bare.body.included[0].relationships.offers).toEqual({ data: [] });
      })
    )
  );

  it.effect("serves a paginated node edge under either declaration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { getDocument } = yield* makeWorld();
        // `Relationship.many`: included in the edge's order, linkage beside the links.
        const many = yield* getDocument("/api/products/p-1?include=reviews");
        expect(many.status).toBe(200);
        expect(many.body.data.relationships.reviews).toEqual({
          links: reviewLinks("p-1"),
          data: [
            { type: "reviews", id: "r-2" },
            { type: "reviews", id: "r-1" },
          ],
        });
        expect(ids(many.body.included)).toEqual(["r-2", "r-1"]);
        // `Relationship.paginated`: links only on a plain list and get...
        const paged = yield* getDocument("/api/paged/products");
        expect(paged.status).toBe(200);
        expect(paged.body.data.map((r: any) => r.relationships.reviews)).toEqual(
          ["p-1", "p-2", "p-3"].map((id) => ({ links: reviewLinks(id) }))
        );
        const one = yield* getDocument("/api/paged/products/p-1");
        expect(one.status).toBe(200);
        expect(one.body.data.relationships.reviews).toEqual({ links: reviewLinks("p-1") });
        // ...and `include=` refused by the endpoint's own codec.
        const refused = yield* getDocument("/api/paged/products?include=reviews");
        expect(refused.status).toBe(400);
        expect(refused.body.errors[0].source).toEqual({ parameter: "include" });
      })
    )
  );

  it.effect("touches no collection the resource does not declare", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { getDocument, calls } = yield* makeWorld(narrowPolicy);
        // `sellers` has a `contracts` edge and the policy knows no `contracts`:
        // the resource declares no relationships, so one phase and a 200.
        const before = calls();
        const listed = yield* getDocument("/api/sellers");
        expect(listed.status).toBe(200);
        expect(listed.body.data).toEqual([
          { type: "sellers", id: "s-1", attributes: { name: "Acme" } },
        ]);
        expect(calls() - before).toBe(2);
        // `products` links to `categories` by key alone; the policy's silence
        // on `categories` costs nothing until a request names it.
        const linked = yield* getDocument("/api/products");
        expect(linked.status).toBe(200);
        expect(linked.body.data[0].relationships.category.data.id).toBe("c-audio");
        const named = yield* getDocument("/api/products?include=category");
        expect(named.status).toBe(403);
        expect(named.body.errors[0].detail).toContain('"categories"');
      })
    )
  );

  it.effect("authorizes a whole batch before evaluating any of it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { getDocument, calls } = yield* makeWorld(narrowPolicy);
        // Phase 2 is one batch: the declared `variants` and `reviews` linkage
        // subsets first, then the requested `categories`. The last is denied,
        // so the phase evaluates nothing — only phase 1's two calls happen.
        const before = calls();
        const { status } = yield* getDocument("/api/products?include=category");
        expect(status).toBe(403);
        expect(calls() - before).toBe(2);
      })
    )
  );

  it.effect(
    "pages by cursor: links.next carries page[after] at the last id, a short page has none",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { getDocument } = yield* makeWorld();
          const first = yield* getDocument("/api/products?sort=name&page[limit]=2");
          expect(ids(first.body.data)).toEqual(["p-3", "p-1"]);
          expect(first.body.links.next).toBe(
            "/api/products?sort=name&page[limit]=2&page[after]=p-1"
          );
          const second = yield* getDocument(first.body.links.next);
          expect(ids(second.body.data)).toEqual(["p-2"]);
          expect(second.body.links).toEqual({
            self: "/api/products?sort=name&page[limit]=2&page[after]=p-1",
          });
        })
      )
  );

  it.effect(
    "pages by offset (#209): links stay in the offset idiom, a short page has no next but keeps prev",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { getDocument } = yield* makeWorld();
          const first = yield* getDocument("/api/products?sort=name&page[offset]=0&page[limit]=2");
          expect(ids(first.body.data)).toEqual(["p-3", "p-1"]);
          expect(first.body.links).toEqual({
            self: "/api/products?sort=name&page[limit]=2&page[offset]=0",
            next: "/api/products?sort=name&page[limit]=2&page[offset]=2",
          });
          const second = yield* getDocument(first.body.links.next);
          expect(ids(second.body.data)).toEqual(["p-2"]);
          expect(second.body.links).toEqual({
            self: "/api/products?sort=name&page[limit]=2&page[offset]=2",
            prev: "/api/products?sort=name&page[limit]=2&page[offset]=0",
          });
          // An offset past every row is a valid, empty page — never a fallthrough
          // or an error; the server has no coverage concept, only the façade does.
          const empty = yield* getDocument("/api/products?sort=name&page[offset]=50&page[limit]=2");
          expect(empty.status).toBe(200);
          expect(empty.body.data).toEqual([]);
        })
      )
  );

  it.effect("rejects page[offset] and page[after] together", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { getDocument } = yield* makeWorld();
        const { status, body } = yield* getDocument("/api/products?page[offset]=1&page[after]=p-1");
        expect(status).toBe(400);
        expect(body.errors[0].source).toEqual({ parameter: "page[offset]" });
      })
    )
  );

  it.effect(
    "projects fields[type] at serialisation while the backend was asked for full rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { getDocument } = yield* makeWorld();
          const { status, body } = yield* getDocument(
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
          const { getDocument } = yield* makeWorld();
          const found = yield* getDocument("/api/products/p-2?include=variants");
          expect(found.status).toBe(200);
          expect(found.body.data.id).toBe("p-2");
          expect(ids(found.body.included)).toEqual(["v-3"]);
          expect(found.body.links).toEqual({
            self: "/api/products?include=variants&filter[id]=p-2&page[limit]=1",
          });
          const missing = yield* getDocument("/api/products/p-9");
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
          const { getDocument } = yield* makeWorld();
          const anonymous = yield* getDocument("/api/cartItems");
          expect(anonymous.status).toBe(200);
          expect(anonymous.body.data).toEqual([]);
          const mine = yield* getDocument("/api/cartItems?include=variant", "u1");
          expect(ids(mine.body.data)).toEqual(["ci-1"]);
          expect(ids(mine.body.included)).toEqual(["v-1"]);
          // A filter for someone else's rows only narrows what the policy allows.
          const theirs = yield* getDocument("/api/cartItems?filter[userId]=u2", "u1");
          expect(theirs.body.data).toEqual([]);
        })
      )
  );

  it.effect(
    "answers a filter over an undeclared field with the codec's 400 before any backend call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { getDocument, calls } = yield* makeWorld();
          const before = calls();
          const { status, body } = yield* getDocument("/api/products?filter[name]=Desk");
          expect(status).toBe(400);
          expect(body.errors[0]).toMatchObject({
            status: "400",
            source: { parameter: "filter[name]" },
          });
          expect(calls()).toBe(before);
          // The graph checks before decoding name their parameter too.
          const include = yield* getDocument("/api/products?include=owner");
          expect(include.status).toBe(400);
          expect(include.body.errors[0].source).toEqual({ parameter: "include" });
          const sorted = yield* getDocument("/api/products/p-1?sort=name");
          expect(sorted.status).toBe(400);
          expect(sorted.body.errors[0].source).toEqual({ parameter: "sort" });
          expect(calls()).toBe(before);
        })
      )
  );

  it.effect("refuses a resource the node graph cannot serve when the handler is built", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { rest } = yield* makeWorld();
        const Secret = Resource.make("secrets", { attributes: { name: Schema.String } });
        expect(() => rest.list(Secret)).toThrow(/no node "secrets"/);
        const Mislinked = Resource.make("sellers", {
          attributes: { name: Schema.String },
          relationships: { owner: Relationship.one(() => Category) },
        });
        expect(() => rest.list(Mislinked)).toThrow(/"owner".*not an edge/);
        const Miskinded = Resource.make("sellers", {
          attributes: { name: Schema.String },
          relationships: { contracts: Relationship.one(() => Category) },
        });
        expect(() => rest.list(Miskinded)).toThrow(
          /"contracts".*"one" but the node edge is "many"/
        );
      })
    )
  );
});
