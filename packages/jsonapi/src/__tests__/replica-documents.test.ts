/**
 * ReplicaDocuments tests (#164): the replica-side writer over a local view —
 * a URL parsed and run over the rows the replica holds, serialised by the
 * one `DocumentWriter` — beside the derived REST handler over a
 * `MemoryBackend` holding the same rows, so "same URL, same result"
 * (ADR-0029 §6) is checked byte for byte on the unit level, including the
 * included resources' own declared linkage (the third batch). Also what the
 * module owns: which relationships it emits (the declarations it is given,
 * or the node graph's synthetic resources), `toCover`, the single-resource
 * shape of `/{type}/{id}`, and the grammar's rejection of a bad URL.
 */
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Schema, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import { Authorization, Edge, MemoryBackend, Node, QueryError } from "@legation/effect";
import { type ClientView, Subset } from "@legation/effect/internal";
import * as JsonApiQuery from "../JsonApiQuery.js";
import * as ReplicaDocuments from "../ReplicaDocuments.js";
import * as RestHandlers from "../RestHandlers.js";

// ─── The graph ───────────────────────────────────────────────────────────────

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
const nodes = Node.registry([categories, products, variants, offers, reviews]);

// ─── The rows both sides hold ────────────────────────────────────────────────

/** A seed row: its id and whatever fields its node declares. */
interface SeedRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

const seed: Readonly<Record<string, ReadonlyArray<SeedRow>>> = {
  categories: [{ id: "c-audio", name: "Audio" }],
  products: [
    { id: "p-1", categoryId: "c-audio", name: "Desk", priceCents: 300 },
    { id: "p-2", categoryId: "c-audio", name: "Lamp", priceCents: 100 },
    { id: "p-3", categoryId: "c-audio", name: "Chair", priceCents: 200 },
  ],
  variants: [
    { id: "v-1", productId: "p-1", sku: "DSK-1" },
    { id: "v-2", productId: "p-1", sku: "DSK-2" },
    { id: "v-3", productId: "p-2", sku: "LMP-1" },
  ],
  offers: [
    { id: "of-1", variantId: "v-1", priceCents: 290 },
    { id: "of-2", variantId: "v-1", priceCents: 280 },
  ],
  reviews: [
    { id: "r-1", productId: "p-1", body: "Solid", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "r-2", productId: "p-1", body: "Sturdy", createdAt: "2026-02-01T00:00:00.000Z" },
  ],
};

/** A replica stand-in: the seed rows evaluated with the reference semantics. */
const view: ClientView.Reader = {
  query: (subset) =>
    Effect.succeed(
      Subset.apply(
        (seed[subset.collection] ?? []).map((value) => ({ id: value.id, value })),
        subset
      )
    ),
  observe: (subset) => Stream.fromEffect(view.query(subset)),
};

/** The same rows in a `MemoryBackend`, behind the derived REST handlers. */
const makeRest = (prefix?: string) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make({
      "seed/put": (args, writer) => {
        const { collection, value } = args as { collection: string; value: { id: string } };
        return writer.put(collection, value.id, value);
      },
    });
    const puts = Object.entries(seed).flatMap(([collection, rows]) =>
      rows.map((value) => ({ collection, value }))
    );
    yield* backend.applyMutations(
      { clientGroupId: "seed" },
      puts.map((args, index) => ({
        clientId: "seed",
        mutationId: index + 1,
        mutator: "seed/put",
        args,
        createdAt: 0,
      }))
    );
    return RestHandlers.make({
      nodes,
      backend,
      policy: Authorization.policy(
        Object.fromEntries([...nodes.nodes.keys()].map((name) => [name, Authorization.allowAll])),
        { collections: nodes.collections }
      ),
      context: () => Effect.succeed({ clientGroupId: "http" }),
      ...(prefix === undefined ? {} : { prefix }),
    });
  });

/** The derived `list` handler's document for a URL, as the endpoint would receive the request. */
const restList = (rest: RestHandlers.RestHandlers, resource: Resource.Any, url: string) =>
  rest.list(resource)({
    request: HttpServerRequest.fromWeb(new Request(`http://shop.test${url}`)),
  });

class NotFound extends Data.TaggedError("NotFound") {}

const restGet = (rest: RestHandlers.RestHandlers, resource: Resource.Any, url: string) =>
  rest.get(resource, { notFound: () => new NotFound() })({
    params: { id: new URL(url, "http://shop.test").pathname.split("/").at(-1)! },
    request: HttpServerRequest.fromWeb(new Request(`http://shop.test${url}`)),
  });

const bytes = (document: unknown) => JSON.stringify(document);

// ─── Declarations: the app's resources, beside the node graph's synthesis ────

const Category = Resource.make("categories", { attributes: { name: Schema.String } });
const Offer = Resource.make("offers", { attributes: { priceCents: Schema.Number } });
const Variant = Resource.make("variants", {
  attributes: { sku: Schema.String },
  relationships: { offers: Relationship.many(() => Offer) },
});
/** Declares `variants` (linkage resolved) and not `reviews` (links only). */
const Product = Resource.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  relationships: {
    category: Relationship.one(() => Category),
    variants: Relationship.many(() => Variant),
  },
});
const declared = new Map<string, Resource.Any>(
  [Category, Offer, Variant, Product].map((resource) => [resource.type, resource])
);

describe("ReplicaDocuments over the replica", () => {
  it.effect(
    "writes the same bytes as the derived REST handler for the same URL and declarations",
    () =>
      Effect.gen(function* () {
        const rest = yield* makeRest();
        const docs = ReplicaDocuments.make({ nodes, resources: declared });
        for (const url of [
          "/products?sort=name",
          "/products?include=variants,category&filter[priceCents][gt]=150&sort=-priceCents",
          "/products?sort=name&page[limit]=2",
          "/products?sort=name&page[limit]=2&page[after]=p-1",
          // Offset pagination (#209): the same "same URL, same result"
          // obligation, for the idiom every audited app actually pages by.
          "/products?sort=name&page[offset]=0&page[limit]=2",
          "/products?sort=name&page[offset]=1&page[limit]=2",
          "/products?sort=name&page[offset]=10&page[limit]=2",
          "/products?fields[products]=name&include=variants&fields[variants]=",
          "/variants?include=offers",
        ]) {
          const local = yield* docs.fromUrl(view, url);
          const served = yield* restList(rest, declared.get(url.split("?")[0]!.slice(1))!, url);
          expect(bytes(local), url).toBe(bytes(served));
        }
        // The included variants carry the linkage their own declaration
        // requires (`offers`), resolved from the replica in the third batch —
        // empty for a variant without offers, never omitted.
        const included = yield* docs.fromUrl(view, "/products/p-1?include=variants");
        const product = { data: { type: "products", id: "p-1" } };
        expect((included as ReplicaDocuments.Document & { included: any }).included).toEqual([
          {
            type: "variants",
            id: "v-1",
            attributes: { sku: "DSK-1" },
            relationships: {
              product,
              offers: {
                data: [
                  { type: "offers", id: "of-1" },
                  { type: "offers", id: "of-2" },
                ],
              },
            },
          },
          {
            type: "variants",
            id: "v-2",
            attributes: { sku: "DSK-2" },
            relationships: { product, offers: { data: [] } },
          },
        ]);
        const got = yield* restGet(rest, Product, "/products/p-1?include=variants");
        expect(bytes(included)).toBe(bytes(got));
      })
  );

  it.effect(
    "without declarations, emits the node graph's edges — what a REST handler over the synthetic resources emits",
    () =>
      Effect.gen(function* () {
        const rest = yield* makeRest("/api");
        const docs = ReplicaDocuments.make({ nodes, prefix: "/api" });
        const synthetic = JsonApiQuery.resourcesOf(nodes);
        const url = "/products?sort=name";
        const local = yield* docs.fromUrl(view, url);
        const served = yield* restList(rest, synthetic.get("products")!, `/api${url}`);
        expect(bytes(local)).toBe(bytes(served));
        // The paginated `reviews` edge is a `many` relationship of the synthetic
        // resource: links, and its rows' linkage in the edge's order.
        const desk = (local as ReplicaDocuments.Document & { data: any }).data[1];
        expect(desk.relationships.reviews).toEqual({
          links: {
            self: "/api/products/p-1/relationships/reviews",
            related: "/api/products/p-1/reviews",
          },
          data: [
            { type: "reviews", id: "r-2" },
            { type: "reviews", id: "r-1" },
          ],
        });
        expect(local.links).toEqual({ self: "/api/products?sort=name" });
      })
  );

  it.effect(
    "writes a single-resource document for /{type}/{id}, null when the replica holds no row",
    () =>
      Effect.gen(function* () {
        const docs = ReplicaDocuments.make({ nodes, resources: declared });
        const found = yield* docs.fromUrl(view, "/shop/products/p-2?include=category");
        expect(found).toEqual({
          data: {
            type: "products",
            id: "p-2",
            attributes: { name: "Lamp", priceCents: 100 },
            relationships: {
              category: { data: { type: "categories", id: "c-audio" } },
              variants: { data: [{ type: "variants", id: "v-3" }] },
              reviews: {
                links: {
                  self: "/products/p-2/relationships/reviews",
                  related: "/products/p-2/reviews",
                },
              },
            },
          },
          included: [{ type: "categories", id: "c-audio", attributes: { name: "Audio" } }],
          links: { self: "/products?include=category&filter[id]=p-2&page[limit]=1" },
        });
        const missing = yield* docs.fromUrl(view, "/products/p-9");
        expect(missing.data).toBeNull();
        // A listing filtered to one id stays a collection document.
        const listed = yield* docs.fromUrl(view, "/products?filter[id]=p-2");
        expect(Array.isArray(listed.data)).toBe(true);
      })
  );

  it.effect(
    "names the reads a request needs covered: the read, then the linkage's collections whole",
    () =>
      Effect.gen(function* () {
        const docs = ReplicaDocuments.make({ nodes, resources: declared });
        const { read: bare } = yield* JsonApiQuery.parseRead(nodes, "/products?sort=name");
        // `variants` is declared `many` and not included: its collection must be held whole.
        expect(yield* docs.toCover(bare)).toEqual([bare, { collection: "variants" }]);
        // Included, the edge is covered by rule 4 itself; the included variants'
        // own declared `offers` is what must be held whole.
        const { read: included } = yield* JsonApiQuery.parseRead(
          nodes,
          "/products?include=variants"
        );
        expect(yield* docs.toCover(included)).toEqual([included, { collection: "offers" }]);
        // A type whose declaration has no `many` relationship needs nothing beyond the read.
        const { read: plain } = yield* JsonApiQuery.parseRead(nodes, "/categories");
        expect(yield* docs.toCover(plain)).toEqual([plain]);
        // The synthetic resources declare every collection edge, paginated included.
        const synthetic = ReplicaDocuments.make({ nodes });
        expect(yield* synthetic.toCover(bare)).toEqual([
          bare,
          { collection: "variants" },
          { collection: "reviews" },
        ]);
      })
  );

  it.effect(
    "refuses an include or fields[] the bound resource does not declare, before any query runs",
    () =>
      Effect.gen(function* () {
        let queries = 0;
        const counting: ClientView.Reader = {
          query: (subset) => {
            queries++;
            return view.query(subset);
          },
          observe: view.observe,
        };
        const docs = ReplicaDocuments.make({ nodes, resources: declared });
        // The node has a `reviews` edge; the `Product` resource declares no such
        // relationship, so the endpoint over it cannot emit it.
        const include = yield* Effect.flip(docs.fromUrl(counting, "/products?include=reviews"));
        expect(include).toBeInstanceOf(QueryError);
        expect(include).toMatchObject({ query: "products", parameter: "include" });
        expect(include.message).toMatch(/"reviews" is not a relationship the "products" resource/);
        // A projection over a type the resource's document never carries.
        const fields = yield* Effect.flip(
          docs.fromUrl(counting, "/products?fields[reviews]=body&include=variants")
        );
        expect(fields).toMatchObject({ query: "products", parameter: "fields[reviews]" });
        // The same checks guard a read handed over already parsed.
        const parsed = yield* JsonApiQuery.parseRead(nodes, "/products/p-1?include=reviews");
        const data = yield* Effect.flip(docs.data(counting, parsed));
        expect(data).toMatchObject({ parameter: "include" });
        expect(queries).toBe(0);
        // What the resource does declare passes; the synthetic resources declare every edge.
        expect((yield* docs.fromUrl(counting, "/products?include=variants")).data).toHaveLength(3);
        const synthetic = ReplicaDocuments.make({ nodes });
        const served = (yield* synthetic.fromUrl(view, "/products/p-1?include=reviews")) as any;
        expect(served.included.map((review: any) => review.id)).toEqual(["r-2", "r-1"]);
      })
  );

  it.effect("fails a URL the grammar rejects with the QueryError naming the parameter", () =>
    Effect.gen(function* () {
      const docs = ReplicaDocuments.make({ nodes, resources: declared });
      const exit = yield* Effect.exit(docs.fromUrl(view, "/products?filter[name]=Desk"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons[0]!;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(QueryError);
          expect((error.error as QueryError).parameter).toBe("filter[name]");
        }
      }
    })
  );

  it("treats a declaration the graph cannot serve as a definition-time defect", () => {
    const Secret = Resource.make("secrets", { attributes: { name: Schema.String } });
    expect(() =>
      ReplicaDocuments.make({ nodes, resources: new Map([["secrets", Secret as Resource.Any]]) })
    ).toThrow(/no node "secrets"/);
    const Mislinked = Resource.make("categories", {
      attributes: { name: Schema.String },
      relationships: { owner: Relationship.one(() => Category) },
    });
    expect(() =>
      ReplicaDocuments.make({
        nodes,
        resources: new Map([["categories", Mislinked as Resource.Any]]),
      })
    ).toThrow(/"owner".*not an edge/);
  });

  it.effect(
    "fails a collection no bound resource declares with a QueryError from every entry point — a URL is network input",
    () =>
      Effect.gen(function* () {
        const docs = ReplicaDocuments.make({ nodes, resources: declared });
        const failures = [
          yield* Effect.flip(docs.toCover({ collection: "reviews" })),
          yield* Effect.flip(docs.fromUrl(view, "/reviews?sort=-createdAt")),
          yield* Effect.flip(docs.collection(view, { read: { collection: "reviews" } })),
          yield* Effect.flip(docs.data(view, { read: { collection: "reviews" }, id: "r-1" })),
        ];
        for (const failure of failures) {
          expect(failure).toBeInstanceOf(QueryError);
          expect(failure.message).toMatch(/No resource declares "reviews"/);
          expect(failure.query).toBe("reviews");
        }
        // Nothing died: the failures were typed, so a façade can route the request on.
        const exit = yield* Effect.exit(docs.fromUrl(view, "/reviews"));
        expect(Exit.isFailure(exit) && exit.cause.reasons.every((r) => r._tag === "Fail")).toBe(
          true
        );
      })
  );
});
