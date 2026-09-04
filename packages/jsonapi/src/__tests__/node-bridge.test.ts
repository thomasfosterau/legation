/**
 * NodeBridge tests: JSON:API resource definitions bridge into the node
 * graph — one/optional → one-edges with derived key fields, promoted key
 * attributes (`options.edges`) close the acyclic-graph gap, many/paginated
 * inverses discover across bridged one-edges, paginated order is required
 * — and the bridged registry drives a real Client read end to end.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import { Filter, Relationship, Resource, Sort } from "@thomasfosterau/effect-jsonapi";
import {
  Authorization,
  Client,
  ClientStore,
  FilterPolicy,
  MemoryBackend,
  Mutator,
  Node,
  Server,
  Transport,
} from "@legation/effect";
import * as NodeBridge from "../NodeBridge.js";

// The commerce trio, declared once as JSON:API resources. The graph is
// acyclic (the library's resource types expand eagerly): products point at
// reviews, and a review carries its `productId` as a plain attribute that
// the bridge promotes to a one-edge.
const Category = Resource.make("categories", {
  attributes: { name: Schema.NonEmptyString },
});

const Review = Resource.make("reviews", {
  attributes: {
    body: Schema.String,
    createdAt: Schema.String,
    productId: Schema.String,
  },
});

const Product = Resource.make("products", {
  attributes: { name: Schema.NonEmptyString },
  relationships: {
    category: Relationship.one(() => Category),
    reviews: Relationship.paginated(() => Review),
  },
});

const bridgeOptions = {
  products: { order: { reviews: ["-createdAt"] } },
  reviews: { edges: { product: { target: "products", via: "productId" } } },
} satisfies Record<string, NodeBridge.FromResourceOptions>;

describe("NodeBridge.fromResource", () => {
  it("bridges one relationships to one-edges with the derived key field", () => {
    const node = NodeBridge.fromResource(Category);
    expect(node.type).toBe("categories");
    expect(Object.keys(node.attributes)).toEqual(["name"]);

    const withEdge = NodeBridge.fromResource(
      Resource.make("profiles", {
        attributes: { bio: Schema.String },
        relationships: { category: Relationship.one(() => Category) },
      })
    );
    expect(withEdge.edges["category"]).toEqual({
      kind: "one",
      target: "categories",
      via: "categoryId",
    });
    // The one-edge key joins the derivable set (ADR-0023).
    expect([...Node.derivableSet(withEdge)]).toEqual(["categoryId"]);
  });

  it("bridges optional relationships as one-edges, honouring via overrides", () => {
    const Profile = Resource.make("profiles", {
      attributes: { bio: Schema.String },
      relationships: { avatar: Relationship.optional(() => Category) },
    });
    expect(NodeBridge.fromResource(Profile).edges["avatar"]).toEqual({
      kind: "one",
      target: "categories",
      via: "avatarId",
    });
    expect(
      NodeBridge.fromResource(Profile, { via: { avatar: "avatar_ref" } }).edges["avatar"]
    ).toEqual({ kind: "one", target: "categories", via: "avatar_ref" });
  });

  it("promotes a key attribute to a one-edge and moves it out of attributes", () => {
    const node = NodeBridge.fromResource(Review, bridgeOptions.reviews);
    expect(node.edges["product"]).toEqual({
      kind: "one",
      target: "products",
      via: "productId",
    });
    // The promoted attribute now lives on the edge, not in attributes.
    expect(Object.keys(node.attributes).sort()).toEqual(["body", "createdAt"]);
    expect([...Node.derivableSet(node)]).toEqual(["productId"]);
  });

  it("passes hint keys through to the node", () => {
    const node = NodeBridge.fromResource(Review, {
      ...bridgeOptions.reviews,
      hintKeys: ["tenantId"],
    });
    expect([...Node.derivableSet(node)].sort()).toEqual(["productId", "tenantId"]);
  });

  it("rejects a paginated relationship without an order", () => {
    expect(() => NodeBridge.fromResource(Product, { inverses: { reviews: "product" } })).toThrow(
      /stable order/
    );
  });

  it("standalone discovery sees only the target's own relationships", () => {
    // Review's one-edge back is option-declared, invisible to fromResource.
    expect(() => NodeBridge.fromResource(Product, bridgeOptions.products)).toThrow(
      /no inverse found/
    );
    // Naming the inverse explicitly always works.
    const node = NodeBridge.fromResource(Product, {
      ...bridgeOptions.products,
      inverses: { reviews: "product" },
    });
    expect(node.edges["reviews"]).toEqual({
      kind: "paginated",
      target: "reviews",
      inverse: "product",
      order: ["-createdAt"],
    });
  });
});

describe("NodeBridge.registry", () => {
  it("discovers inverses across bridged one-edges, declared ones included", () => {
    const nodes = NodeBridge.registry([Category, Product, Review], bridgeOptions);
    expect([...nodes.nodes.keys()].sort()).toEqual(["categories", "products", "reviews"]);
    expect(nodes.nodes.get("products")!.edges["reviews"]).toEqual({
      kind: "paginated",
      target: "reviews",
      inverse: "product",
      order: ["-createdAt"],
    });
    // The engine registry carries the joins edge-for-edge.
    const product = nodes.collections.get("products");
    expect(product?.relationships?.map((rel) => rel.name).sort()).toEqual(["category", "reviews"]);
  });

  it("rejects an ambiguous inverse, naming the candidates", () => {
    const Message = Resource.make("messages", {
      attributes: { senderId: Schema.String, recipientId: Schema.String },
    });
    const Account = Resource.make("accounts", {
      attributes: { name: Schema.String },
      relationships: { messages: Relationship.many(() => Message) },
    });
    const edges = {
      sender: { target: "accounts", via: "senderId" },
      recipient: { target: "accounts", via: "recipientId" },
    };
    expect(() => NodeBridge.registry([Message, Account], { messages: { edges } })).toThrow(
      /"sender", "recipient"/
    );
    const nodes = NodeBridge.registry([Message, Account], {
      messages: { edges },
      accounts: { inverses: { messages: "recipient" } },
    });
    expect(nodes.nodes.get("accounts")!.edges["messages"]).toEqual({
      kind: "many",
      target: "messages",
      inverse: "recipient",
    });
  });

  it("surfaces graph mismatches at close time", () => {
    // Product's category edge targets a resource missing from the graph.
    expect(() => NodeBridge.registry([Product, Review], bridgeOptions)).toThrow();
  });
});

// ─── End to end: the bridged graph drives a Client read ─────────────────────

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

describe("a bridged registry over a real engine", () => {
  it.effect("windowed includes resolve through bridged edges", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nodes = NodeBridge.registry([Category, Product, Review], bridgeOptions);

        const productSet = Mutator.make("product/set", Schema.Unknown);
        const reviewSet = Mutator.make("review/set", Schema.Unknown);
        const mutations = Mutator.registry([
          {
            mutator: productSet,
            local: (args, writer) => writer.put("products", (args as { id: string }).id, args),
          },
          {
            mutator: reviewSet,
            local: (args, writer) => writer.put("reviews", (args as { id: string }).id, args),
          },
        ]);

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
        const server = yield* Server.make({
          backend,
          auth: {
            policy: Authorization.policy({
              products: Authorization.allowAll,
              reviews: Authorization.allowAll,
              categories: Authorization.allowAll,
            }),
          },
        });
        const store = yield* ClientStore.makeMemory;
        const transport = yield* Transport.makeInMemory(server.handler, "group-bridge");
        const client = yield* Client.make({
          nodes,
          mutations,
          clientId: "client-bridge",
          clientGroupId: "group-bridge",
          syncLoop: { pushDebounce: "10 millis" },
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, transport)
        );

        yield* client.mutate("product/set", { id: "p-1", name: "Desk", categoryId: "c-1" });
        for (const [id, at] of [
          ["r-1", "2026-01-01"],
          ["r-2", "2026-03-01"],
          ["r-3", "2026-02-01"],
        ] as const) {
          yield* client.mutate("review/set", { id, body: id, createdAt: at, productId: "p-1" });
        }

        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            (rows) =>
              Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        // The bridged paginated edge windows the join: newest two, edge order.
        const reviews = yield* eventually(Ref.get(latest), (rows) => rows.length === 2);
        expect(reviews.map((row) => row.id)).toEqual(["r-2", "r-3"]);
      })
    )
  );
});

describe("NodeBridge filterable set (#154, #161)", () => {
  it("reads the resource's own declaration; relationship filters land on the key field", () => {
    const Author = Resource.make("authors", { attributes: { name: Schema.String } });
    const Article = Resource.make("articles", {
      attributes: {
        title: Schema.String.pipe(Filter.able(["eq", "in"]), Sort.able()),
        words: Resource.attribute(Schema.Int, { filter: true, sort: true }),
        rating: Schema.NullOr(Schema.Number.pipe(Filter.able(["gte", "isnull"]))),
        body: Schema.String,
        publishedAt: Schema.String.pipe(Filter.able(["gt", "lt"])),
      },
      relationships: { author: Relationship.one(() => Author, { filter: ["eq", "in", "isnull"] }) },
    });
    const node = NodeBridge.fromResource(Article, {
      // The option overrides a field's declaration: the kind no schema can tell.
      filterable: { publishedAt: { operators: ["gt", "lt"], kind: "instant" } },
      sortable: ["publishedAt"],
    });
    expect(node.filterable).toEqual({
      id: { kind: "text", operators: ["eq", "in"] },
      authorId: { kind: "text", operators: ["eq", "in", "isnull"] },
      title: { kind: "text", operators: ["eq", "in"] },
      words: { kind: "integer", operators: FilterPolicy.operators },
      rating: { kind: "double", operators: ["gte", "isnull"] },
      publishedAt: { kind: "instant", operators: ["gt", "lt"] },
    });
    expect(node.sortable).toEqual(["id", "title", "words", "publishedAt"]);
  });

  it("passes filterable / sortable through to the node, keeping the key defaults", () => {
    const node = NodeBridge.fromResource(Review, {
      edges: { product: { target: "products", via: "productId" } },
      filterable: { body: ["eq"], createdAt: { operators: ["gt", "lt"], kind: "instant" } },
      sortable: ["createdAt"],
    });
    expect(node.filterable).toEqual({
      id: { kind: "text", operators: ["eq", "in"] },
      productId: { kind: "text", operators: ["eq", "in"] },
      body: { kind: "text", operators: ["eq"] },
      createdAt: { kind: "instant", operators: ["gt", "lt"] },
    });
    expect(node.sortable).toEqual(["id", "createdAt"]);
    // Nothing declared: only the key fields are reachable.
    expect(Object.keys(NodeBridge.fromResource(Category).filterable)).toEqual(["id"]);
  });
});
