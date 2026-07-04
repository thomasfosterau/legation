/**
 * The Node/Edge model (ADR-0022, program step 2): definitions, branded ids,
 * row-schema derivation (id + attributes + one-edge key fields), graph
 * closure/validation, the derivable set (ADR-0023), and the bridge — the
 * derived CollectionRegistry driving the EXISTING engine's Related joins.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import {
  Authorization,
  Backend,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Transport,
} from "../index.js";
import { ClientEngine, Cvr, InvalidationBus, Related, Subset, SyncServer } from "../internal.js";

const Category = Node.make("categories", {
  attributes: { name: Schema.String },
});

const Product = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
});

const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: {
    product: Edge.one("products", { via: "productId" }),
  },
  hintKeys: ["authorName"],
});

describe("Node model", () => {
  it("derives the row schema: id + attributes + one-edge key fields", () => {
    const decoded = Schema.decodeUnknownSync(Review.row)({
      id: "r-1",
      body: "great",
      createdAt: "2026-07-03",
      productId: "p-1",
    });
    expect(decoded.id).toBe("r-1");
    expect(decoded.productId).toBe("p-1");
    expect(() =>
      Schema.decodeUnknownSync(Review.row)({ id: "r-1", body: "missing the rest" })
    ).toThrow();
  });

  it("brands ids per node type", () => {
    const productId: typeof Product.Id.Type = Product.Id.make("p-1");
    expect(productId).toBe("p-1");
    // One-edge key fields carry the TARGET type's brand.
    const row = Schema.decodeUnknownSync(Review.row)({
      id: "r-1",
      body: "b",
      createdAt: "t",
      productId: "p-1",
    });
    const target: typeof Product.Id.Type = row.productId;
    expect(target).toBe("p-1");
  });

  it("computes the derivable set: one-edge keys + hintKeys", () => {
    expect([...Node.derivableSet(Review)].sort()).toEqual(["authorName", "productId"]);
    expect([...Node.derivableSet(Category)]).toEqual([]);
  });

  it("closes the graph: unknown targets and bad inverses throw", () => {
    const Dangling = Node.make("dangling", {
      attributes: {},
      edges: { nowhere: Edge.one("missing", { via: "missingId" }) },
    });
    expect(() => Node.registry([Dangling])).toThrow(/missing/);

    const BadInverse = Node.make("bad", {
      attributes: {},
      edges: { reviews: Edge.many("reviews", { inverse: "category" }) },
    });
    expect(() => Node.registry([BadInverse, Review, Product, Category])).toThrow(/inverse/);
  });

  it("derives the engine registry: edges become relationships, both directions", () => {
    const { collections } = Node.registry([Category, Product, Review]);
    const products = collections.get("products")!;
    expect(products.relationships).toContainEqual({
      name: "category",
      kind: "one",
      collection: "categories",
      localField: "categoryId",
      foreignField: "id",
    });
    // The paginated edge's key is resolved from its INVERSE on the child;
    // its kind and declared order survive into the registry (ADR-0024).
    expect(products.relationships).toContainEqual({
      name: "reviews",
      kind: "paginated",
      collection: "reviews",
      localField: "id",
      foreignField: "productId",
      order: [{ field: "createdAt", direction: "desc" }],
    });
  });
});

// ─── The bridge: Node-derived registry drives the existing engine ───────────

const productSet = Mutator.make("product/set", Schema.Unknown);
const reviewSet = Mutator.make("review/set", Schema.Unknown);
const mutators = Mutator.registry([
  {
    mutator: productSet,
    local: (args, writer) => writer.put("products", (args as { id: string }).id, args),
  },
  {
    mutator: reviewSet,
    local: (args, writer) => writer.put("reviews", (args as { id: string }).id, args),
  },
]);

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(productSet, (args, writer) =>
        writer.put("products", (args as { id: string }).id, args)
      ),
      MemoryBackend.handler(reviewSet, (args, writer) =>
        writer.put("reviews", (args as { id: string }).id, args)
      ),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({
        products: Authorization.allowAll,
        reviews: Authorization.allowAll,
        categories: Authorization.allowAll,
      })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-node");
  return yield* ClientEngine.make({
    clientId: "client-node",
    clientGroupId: "group-node",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
});

describe("Node registry over the existing engine", () => {
  it.effect("Related joins resolve through Node-derived relationships", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { collections } = Node.registry([Category, Product, Review]);
        const engine = yield* makeEngine;

        yield* engine.mutate("product/set", {
          id: "p-1",
          name: "Desk",
          priceCents: 100,
          categoryId: "c-1",
        });
        yield* engine.mutate("review/set", {
          id: "r-1",
          body: "sturdy",
          createdAt: "t1",
          productId: "p-1",
        });

        const stream = yield* Related.related(
          engine,
          collections,
          "reviews",
          Subset.make({ collection: "reviews" }),
          ["product"]
        );
        const first = yield* Stream.runHead(Stream.take(stream, 1));
        const rows = first._tag === "Some" ? first.value : [];
        expect(rows).toHaveLength(1);
        expect((rows[0]!.related["product"] as { name: string }).name).toBe("Desk");
      })
    )
  );
});
