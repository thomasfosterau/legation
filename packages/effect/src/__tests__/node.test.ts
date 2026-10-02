/**
 * The Node/Edge model (ADR-0022, program step 2): definitions, branded ids,
 * row-schema derivation (id + attributes + one-edge key fields), graph
 * closure/validation, the derivable set (ADR-0023), and the bridge — the
 * derived CollectionRegistry driving the EXISTING engine's Related joins.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import {
  Authorization,
  Backend,
  ClientStore,
  Collection,
  Edge,
  FilterPolicy,
  MemoryBackend,
  Mutator,
  Node,
  Predicate,
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

  it("keeps AnyNode's Id a string-encoded branded id schema", () => {
    const decoded: string = Schema.decodeUnknownSync(Product.Id)("p-1");
    expectTypeOf<Node.AnyNode["Id"]["Type"]>().toExtend<string>();
    expectTypeOf<Node.AnyNode["Id"]["Encoded"]>().toEqualTypeOf<string>();
    expectTypeOf(Product).toExtend<Node.AnyNode>();
    expect(decoded).toBe("p-1");
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

// ─── Declared identity attributes (natural keys, #144) ──────────────────────
//
// Conduit's shape: authors are identified by `username`, posts by `slug`, and
// a node that declares nothing keeps today's synthetic `id` — so one graph
// exercises every combination an edge can join across.

const Author = Node.make("authors", {
  id: "username",
  attributes: { username: Schema.String, bio: Schema.String },
  edges: { posts: Edge.many("posts", { inverse: "author" }) },
});

const Post = Node.make("posts", {
  id: "slug",
  attributes: { slug: Schema.String, title: Schema.String },
  edges: { author: Edge.one("authors", { via: "authorName" }) },
});

/** Identity left undeclared, pointing at a node that declares one. */
const Bookmark = Node.make("bookmarks", {
  attributes: { note: Schema.String },
  edges: { post: Edge.one("posts", { via: "postSlug" }) },
});

describe("Node identity attribute", () => {
  it("defaults to id, and names the declared attribute when given", () => {
    expect(Review.id).toBe("id");
    expect(Author.id).toBe("username");
    expect(Post.id).toBe("slug");
    expect(Bookmark.id).toBe("id");
  });

  it("drops the synthetic id from the row: the declared attribute carries it", () => {
    expect(Object.keys(Author.row.fields)).toEqual(["username", "bio"]);
    const decoded = Schema.decodeUnknownSync(Post.row)({
      slug: "hello-world",
      title: "Hello",
      authorName: "ada",
    });
    expect(decoded.slug).toBe("hello-world");
    // The declared identity is an ordinary attribute — no `id` to keep equal.
    expect("id" in decoded).toBe(false);
    // A node declaring nothing still gets the branded `id` in front.
    expect(Object.keys(Bookmark.row.fields)).toEqual(["id", "note", "postSlug"]);
  });

  it("is the filterable and sortable key, with no phantom id", () => {
    expect(Author.filterable).toEqual({ username: FilterPolicy.keyDefaults });
    expect(Author.sortable).toEqual(["username"]);
    expect(Post.filterable).toEqual({
      slug: FilterPolicy.keyDefaults,
      authorName: FilterPolicy.keyDefaults,
    });
    expect(Post.sortable).toEqual(["slug"]);
    expect(Author.filterable["id"]).toBeUndefined();
    expect(Post.sortable).not.toContain("id");
  });

  it("rejects an identity attribute whose kind is not text", () => {
    expect(() => Node.make("ratings", { id: "score", attributes: { score: Schema.Int } })).toThrow(
      /identity attribute.*literal kind is "integer"/
    );
  });

  it("is type-checked against the node's own attributes", () => {
    const node = Node.make("tags", {
      // @ts-expect-error "label" is not one of this node's attributes
      id: "label",
      attributes: { name: Schema.String },
    });
    // The type error is the contract; the value still carries what was asked.
    expect(node.id).toBe("label");
  });

  it("resolves each end of an edge from its own node's identity", () => {
    const { collections } = Node.registry([Author, Post, Bookmark]);
    expect(collections.get("posts")!.relationships).toContainEqual({
      name: "author",
      kind: "one",
      collection: "authors",
      localField: "authorName",
      foreignField: "username",
    });
    expect(collections.get("authors")!.relationships).toContainEqual({
      name: "posts",
      kind: "many",
      collection: "posts",
      localField: "username",
      foreignField: "authorName",
    });
    // A node with the default identity joining one with a declared identity.
    expect(collections.get("bookmarks")!.relationships).toContainEqual({
      name: "post",
      kind: "one",
      collection: "posts",
      localField: "postSlug",
      foreignField: "slug",
    });
  });

  it("extracts the row id from the declared attribute, and carries its name", () => {
    const { collections } = Node.registry([Author, Post, Bookmark]);
    const authors = collections.get("authors")!;
    expect(authors.identity).toBe("username");
    expect(authors.id({ username: "ada", bio: "" })).toBe("ada");
    const bookmarks = collections.get("bookmarks")!;
    expect(bookmarks.identity).toBe("id");
    expect(bookmarks.id({ id: "b-1", note: "", postSlug: "hello-world" })).toBe("b-1");
  });

  it("admits a read filtering and sorting on the declared identity", () => {
    const { collections } = Node.registry([Author, Post, Bookmark]);
    const declaration = Collection.filterDeclarationOf(collections.get("posts")!);
    expect(
      FilterPolicy.check("posts", declaration, {
        where: Predicate.eq("slug", "hello-world"),
        orderBy: [{ field: "slug", direction: "asc" }],
      })
    ).toBeUndefined();
    // …and nothing is filterable or sortable under the old literal name.
    expect(
      FilterPolicy.check("posts", declaration, {
        where: Predicate.eq("id", "hello-world"),
        orderBy: [],
      })?.message
    ).toMatch(/field "id" is not filterable/);
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

/**
 * The same rig over the natural-key graph: rows are keyed by the attribute
 * each node declares as its identity, so nothing in the journal, the backend
 * or the CVR ever sees an `id` field.
 */
const authorSet = Mutator.make("author/set", Schema.Unknown);
const postSet = Mutator.make("post/set", Schema.Unknown);
const naturalKeyMutators = Mutator.registry([
  {
    mutator: authorSet,
    local: (args, writer) => writer.put("authors", (args as { username: string }).username, args),
  },
  {
    mutator: postSet,
    local: (args, writer) => writer.put("posts", (args as { slug: string }).slug, args),
  },
]);

const makeNaturalKeyEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(authorSet, (args, writer) =>
        writer.put("authors", (args as { username: string }).username, args)
      ),
      MemoryBackend.handler(postSet, (args, writer) =>
        writer.put("posts", (args as { slug: string }).slug, args)
      ),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      // With the registry attached, every subscription the joins register is
      // admitted against the declared identities — `authorName IN (…)` on the
      // way out, `username IN (…)` on the way back (#144).
      Authorization.policy(
        { authors: Authorization.allowAll, posts: Authorization.allowAll },
        { collections: Node.registry([Author, Post]).collections }
      )
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-natural");
  return yield* ClientEngine.make({
    clientId: "client-natural",
    clientGroupId: "group-natural",
    mutators: naturalKeyMutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
});

/** The first emission of a `Related` stream. */
const firstRows = <A, E, R>(stream: Stream.Stream<ReadonlyArray<A>, E, R>) =>
  Effect.map(Stream.runHead(Stream.take(stream, 1)), (head) =>
    head._tag === "Some" ? head.value : []
  );

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

  it.effect("…and through declared identities, each end resolved from its node", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { collections } = Node.registry([Author, Post]);
        const engine = yield* makeNaturalKeyEngine;

        yield* engine.mutate("author/set", { username: "ada", bio: "engine" });
        yield* engine.mutate("post/set", {
          slug: "hello-world",
          title: "Hello",
          authorName: "ada",
        });

        // `posts.author`: authorName → authors.username.
        const authorOf = yield* Related.related(
          engine,
          collections,
          "posts",
          Subset.make({ collection: "posts" }),
          ["author"]
        );
        const posts = yield* firstRows(authorOf);
        expect(posts).toHaveLength(1);
        expect((posts[0]!.related["author"] as { bio: string }).bio).toBe("engine");

        // The inverse: authors.username → posts.authorName.
        const postsOf = yield* Related.related(
          engine,
          collections,
          "authors",
          Subset.make({ collection: "authors" }),
          ["posts"]
        );
        const authors = yield* firstRows(postsOf);
        expect(authors).toHaveLength(1);
        expect(
          (authors[0]!.related["posts"] as ReadonlyArray<{ slug: string }>).map((row) => row.slug)
        ).toEqual(["hello-world"]);
      })
    )
  );
});
