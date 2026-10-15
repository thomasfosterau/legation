/**
 * The filterable set (ADR-0028 rule d, #154): declared on the Node with
 * `id` / one-edge key defaults and schema-derived literal kinds, carried on
 * the Collection, and enforced by `authorize` on pull and read before
 * `Backend.evaluate` — while the auth filter's own predicate and a named
 * query's server-resolved subset stay exempt.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import {
  Authorization,
  type Backend,
  Collection,
  Edge,
  FilterDeclarationError,
  FilterPolicy,
  MemoryBackend,
  Mutator,
  Node,
  Predicate,
  Query,
  Server,
  type AuthorizationError,
  type TransportError,
} from "../index.js";
import { Subset } from "../internal.js";

const Category = Node.make("categories", { attributes: { name: Schema.String } });

const Product = Node.make("products", {
  attributes: {
    name: Schema.String,
    priceCents: Schema.Int,
    rating: Schema.Number,
    archived: Schema.Boolean,
    status: Schema.Literals(["draft", "live"]),
    createdAt: Schema.String,
  },
  edges: { category: Edge.one("categories", { via: "categoryId" }) },
  filterable: {
    name: ["eq"],
    priceCents: ["gte", "lte"],
    archived: ["eq"],
    status: ["in"],
    createdAt: { operators: ["gt"], kind: "instant" },
  },
  sortable: ["name"],
});

const nodes = Node.registry([Category, Product]);

describe("FilterPolicy: declaration", () => {
  it("defaults: id and every one-edge key are eq/in text; id is sortable", () => {
    expect(Category.filterable).toEqual({ id: { kind: "text", operators: ["eq", "in"] } });
    expect(Category.sortable).toEqual(["id"]);
    expect(Product.filterable["categoryId"]).toEqual(FilterPolicy.keyDefaults);
    expect(Product.filterable["id"]).toEqual(FilterPolicy.keyDefaults);
    expect(Product.sortable).toEqual(["id", "name"]);
  });

  it("derives the literal kind from the attribute schema, with an explicit override", () => {
    expect(Product.filterable["name"]).toEqual({ kind: "text", operators: ["eq"] });
    expect(Product.filterable["priceCents"]).toEqual({
      kind: "integer",
      operators: ["gte", "lte"],
    });
    expect(Product.filterable["archived"]).toEqual({ kind: "boolean", operators: ["eq"] });
    expect(Product.filterable["status"]).toEqual({ kind: "text", operators: ["in"] });
    expect(Product.filterable["createdAt"]).toEqual({ kind: "instant", operators: ["gt"] });
    expect(FilterPolicy.kindOf(Schema.Number)).toBe("double");
    expect(FilterPolicy.kindOf(Schema.NullOr(Schema.Int))).toBe("integer");
    expect(FilterPolicy.kindOf(Schema.optional(Schema.String))).toBe("text");
    expect(FilterPolicy.kindOf(Schema.Date)).toBeUndefined();
  });

  it("a key field listed in filterable widens its eq/in defaults, never replaces them", () => {
    const Widened = Node.make("widened", {
      attributes: {},
      edges: { category: Edge.one("categories", { via: "categoryId" }) },
      filterable: { categoryId: ["ne"], id: { operators: ["ne"], kind: "text" } },
    });
    expect(Widened.filterable["categoryId"]).toEqual({
      kind: "text",
      operators: ["eq", "in", "ne"],
    });
    expect(Widened.filterable["id"]).toEqual({ kind: "text", operators: ["eq", "in", "ne"] });
  });

  it("a paginated edge's order fields join its target's sortable when the graph closes", () => {
    const Post = Node.make("posts", {
      attributes: { title: Schema.String },
      edges: { replies: Edge.paginated("replies", { inverse: "post", order: ["-createdAt"] }) },
    });
    const Reply = Node.make("replies", {
      attributes: { body: Schema.String, createdAt: Schema.String },
      edges: { post: Edge.one("posts", { via: "postId" }) },
    });
    expect(Reply.sortable).toEqual(["id"]);
    const graph = Node.registry([Post, Reply]);
    expect(graph.nodes.get("replies")!.sortable).toEqual(["id", "createdAt"]);
    expect(graph.collections.get("replies")!.sortable).toEqual(["id", "createdAt"]);
    // Untouched where no paginated edge orders the node.
    expect(graph.nodes.get("posts")).toBe(Post);

    const Dangling = Node.make("posts", {
      attributes: {},
      edges: { replies: Edge.paginated("replies", { inverse: "post", order: ["-score"] }) },
    });
    expect(() => Node.registry([Dangling, Reply])).toThrow(FilterDeclarationError);
  });

  it("an undeclared field or an underivable kind is a definition-time defect", () => {
    expect(() =>
      Node.make("bad", {
        attributes: { name: Schema.String },
        filterable: { nope: ["eq"] } as never,
      })
    ).toThrow(FilterDeclarationError);
    expect(() =>
      Node.make("bad", { attributes: { name: Schema.String }, sortable: ["nope"] as never })
    ).toThrow(FilterDeclarationError);
    expect(() =>
      Node.make("bad", { attributes: { at: Schema.Date }, filterable: { at: ["eq"] } })
    ).toThrow(/declare its kind explicitly/);
    expect(
      Node.make("ok", {
        attributes: { at: Schema.Date },
        filterable: { at: { operators: ["eq"], kind: "instant" } },
      }).filterable["at"]
    ).toEqual({ kind: "instant", operators: ["eq"] });
  });

  it("travels onto the derived Collection, like indexes", () => {
    const products = nodes.collections.get("products")!;
    expect(products.filterable).toEqual(Product.filterable);
    expect(products.sortable).toEqual(Product.sortable);
    expect(Collection.filterDeclarationOf(products)).toEqual({
      filterable: Product.filterable,
      sortable: Product.sortable,
    });
  });

  it("a hand-built collection's declaration is overlaid on the key defaults", () => {
    const comments = Collection.make({
      name: "comments",
      schema: Schema.Unknown,
      id: (value) => (value as { id: string }).id,
      relationships: [
        {
          name: "issue",
          kind: "one",
          collection: "issues",
          localField: "issueId",
          foreignField: "id",
        },
      ],
      filterable: {
        body: { kind: "text", operators: ["eq"] },
        issueId: { kind: "text", operators: ["ne"] },
      },
      sortable: ["createdAt"],
    });
    expect(Collection.filterDeclarationOf(comments)).toEqual({
      filterable: {
        id: FilterPolicy.keyDefaults,
        issueId: { kind: "text", operators: ["eq", "in", "ne"] },
        body: { kind: "text", operators: ["eq"] },
      },
      sortable: ["id", "createdAt"],
    });
  });

  it("a hand-built collection without a declaration is closed to its key fields", () => {
    const comments = Collection.make({
      name: "comments",
      schema: Schema.Unknown,
      id: (value) => (value as { id: string }).id,
      relationships: [
        {
          name: "issue",
          kind: "one",
          collection: "issues",
          localField: "issueId",
          foreignField: "id",
        },
      ],
    });
    expect(Collection.filterDeclarationOf(comments)).toEqual({
      filterable: { id: FilterPolicy.keyDefaults, issueId: FilterPolicy.keyDefaults },
      sortable: ["id"],
    });
  });
});

// ─── Enforcement ─────────────────────────────────────────────────────────────

const context = { clientGroupId: "g" };

const policy = (
  filters: Readonly<Record<string, Authorization.AuthFilter>> = {
    products: Authorization.allowAll,
    categories: Authorization.allowAll,
  }
) => Authorization.policy(filters, { collections: nodes.collections });

const products = (options: {
  readonly where?: Predicate.Predicate;
  readonly orderBy?: ReadonlyArray<Subset.OrderBy>;
}) => Subset.make({ collection: "products", ...options });

/** The `AuthorizationError` an `authorize` call fails with. */
const denied = (subset: Subset.Subset, authPolicy = policy()) =>
  Effect.flip(Authorization.authorize(authPolicy, context, subset));

describe("FilterPolicy: authorize", () => {
  it.effect("refuses an undeclared field, naming collection, field and operator", () =>
    Effect.gen(function* () {
      const error = yield* denied(products({ where: Predicate.eq("rating", 5) }));
      expect(error.collection).toBe("products");
      expect(error.message).toMatch(/Collection "products": field "rating" is not filterable/);
    })
  );

  it.effect("refuses a declared field with an undeclared operator", () =>
    Effect.gen(function* () {
      const error = yield* denied(products({ where: Predicate.gt("name", "a") }));
      expect(error.message).toMatch(/field "name" is not filterable with "gt" \(declared: eq\)/);
      const viaIn = yield* denied(products({ where: Predicate.isIn("name", ["a"]) }));
      expect(viaIn.message).toMatch(/field "name" is not filterable with "in"/);
    })
  );

  it.effect("refuses a literal that does not match the declared kind", () =>
    Effect.gen(function* () {
      const text = yield* denied(products({ where: Predicate.eq("name", 5) }));
      expect(text.message).toMatch(
        /literal 5 for field "name" \("eq"\) does not match its kind "text"/
      );
      const integer = yield* denied(products({ where: Predicate.gte("priceCents", 1.5) }));
      expect(integer.message).toMatch(/kind "integer"/);
      const range = yield* denied(products({ where: Predicate.lte("priceCents", 2 ** 40) }));
      expect(range.message).toMatch(/kind "integer"/);
      const boolean = yield* denied(products({ where: Predicate.eq("archived", "true") }));
      expect(boolean.message).toMatch(/kind "boolean"/);
      const instant = yield* denied(products({ where: Predicate.gt("createdAt", "yesterday") }));
      expect(instant.message).toMatch(/kind "instant"/);
      const inList = yield* denied(products({ where: Predicate.isIn("status", ["live", 1]) }));
      expect(inList.message).toMatch(/literal 1 for field "status" \("in"\)/);
    })
  );

  it.effect("a null literal is the wire form of isnull and needs that operator", () =>
    Effect.gen(function* () {
      const error = yield* denied(products({ where: Predicate.eq("name", null) }));
      expect(error.message).toMatch(/field "name" is not filterable with "isnull"/);
      const Nullable = Node.make("nullable", {
        attributes: { note: Schema.NullOr(Schema.String) },
        filterable: { note: ["isnull"] },
      });
      const admitted = yield* Authorization.authorize(
        Authorization.policy(
          { nullable: Authorization.allowAll },
          { collections: Node.registry([Nullable]).collections }
        ),
        context,
        Subset.make({ collection: "nullable", where: Predicate.ne("note", null) })
      );
      expect(admitted.collection).toBe("nullable");
    })
  );

  it.effect("Not(In) is nin and a negated null test is isnull, in both directions", () =>
    Effect.gen(function* () {
      const Tagged = Node.make("tagged", {
        attributes: {
          tag: Schema.String,
          colour: Schema.String,
          note: Schema.NullOr(Schema.String),
          kind: Schema.NullOr(Schema.String),
        },
        filterable: { tag: ["nin"], colour: ["in"], note: ["isnull"], kind: ["eq"] },
      });
      const tagged = Authorization.policy(
        { tagged: Authorization.allowAll },
        { collections: Node.registry([Tagged]).collections }
      );
      const check = (where: Predicate.Predicate) =>
        Authorization.authorize(tagged, context, Subset.make({ collection: "tagged", where }));

      // nin-only: Not(In) admitted, In refused.
      yield* check(Predicate.not(Predicate.isIn("tag", ["a", "b"])));
      const inOnNin = yield* Effect.flip(check(Predicate.isIn("tag", ["a"])));
      expect(inOnNin.message).toMatch(/field "tag" is not filterable with "in" \(declared: nin\)/);
      // in-only: In admitted, Not(In) refused.
      yield* check(Predicate.isIn("colour", ["red"]));
      const ninOnIn = yield* Effect.flip(check(Predicate.not(Predicate.isIn("colour", ["red"]))));
      expect(ninOnIn.message).toMatch(/field "colour" is not filterable with "nin"/);
      // Literals under Not(In) are still kind-checked.
      const badLiteral = yield* Effect.flip(check(Predicate.not(Predicate.isIn("tag", [1]))));
      expect(badLiteral.message).toMatch(/literal 1 for field "tag" \("nin"\)/);
      // isnull: the null test and its negation both need `isnull`.
      yield* check(Predicate.not(Predicate.eq("note", null)));
      yield* check(Predicate.ne("note", null));
      const nullOnEq = yield* Effect.flip(check(Predicate.not(Predicate.eq("kind", null))));
      expect(nullOnEq.message).toMatch(/field "kind" is not filterable with "isnull"/);
    })
  );

  it.effect("the NotIn and IsNull nodes are checked as nin and isnull", () =>
    Effect.gen(function* () {
      const Tagged = Node.make("tagged", {
        attributes: {
          tag: Schema.String,
          colour: Schema.String,
          note: Schema.NullOr(Schema.String),
          kind: Schema.NullOr(Schema.String),
        },
        filterable: { tag: ["nin"], colour: ["in"], note: ["isnull"], kind: ["eq"] },
      });
      const tagged = Authorization.policy(
        { tagged: Authorization.allowAll },
        { collections: Node.registry([Tagged]).collections }
      );
      const check = (where: Predicate.Predicate) =>
        Authorization.authorize(tagged, context, Subset.make({ collection: "tagged", where }));

      // NotIn needs `nin`, and its literals are kind-checked.
      yield* check(Predicate.notIn("tag", ["a", "b"]));
      const ninOnIn = yield* Effect.flip(check(Predicate.notIn("colour", ["red"])));
      expect(ninOnIn.message).toMatch(
        /field "colour" is not filterable with "nin" \(declared: in\)/
      );
      const badLiteral = yield* Effect.flip(check(Predicate.notIn("tag", [1])));
      expect(badLiteral.message).toMatch(/literal 1 for field "tag" \("nin"\)/);
      // IsNull, negated or not, needs `isnull`; `eq(f, null)` desugars to it.
      yield* check(Predicate.isNull("note"));
      yield* check(Predicate.isNotNull("note"));
      yield* check(Predicate.eq("note", null));
      const nullOnEq = yield* Effect.flip(check(Predicate.isNull("kind")));
      expect(nullOnEq.message).toMatch(/field "kind" is not filterable with "isnull"/);
      const negatedOnEq = yield* Effect.flip(check(Predicate.isNotNull("kind")));
      expect(negatedOnEq.message).toMatch(/field "kind" is not filterable with "isnull"/);
    })
  );

  it.effect("refuses a client-supplied Exists anywhere in the predicate", () =>
    Effect.gen(function* () {
      const exists = Predicate.exists({
        collection: "categories",
        localField: "categoryId",
        foreignField: "id",
      });
      const error = yield* denied(
        products({ where: Predicate.and(Predicate.eq("id", "p-1"), Predicate.not(exists)) })
      );
      expect(error.message).toMatch(/"Exists" is not allowed in a client predicate/);
    })
  );

  it.effect("refuses an orderBy over an unsortable field", () =>
    Effect.gen(function* () {
      const error = yield* denied(
        products({ orderBy: [{ field: "priceCents", direction: "asc" }] })
      );
      expect(error.message).toMatch(/field "priceCents" is not sortable \(sortable: id, name\)/);
    })
  );

  it.effect("admits a declared predicate and orderBy, then ANDs the auth filter", () =>
    Effect.gen(function* () {
      const where = Predicate.and(
        Predicate.isIn("categoryId", ["c-1", "c-2"]),
        Predicate.or(Predicate.lte("priceCents", 1000), Predicate.eq("archived", false)),
        Predicate.isIn("status", ["live"]),
        Predicate.gt("createdAt", "2026-09-01T00:00:00.000Z")
      );
      const admitted = yield* Authorization.authorize(
        policy({ products: () => Effect.succeed(Predicate.eq("rating", 5)) }),
        context,
        products({ where, orderBy: [{ field: "name", direction: "desc" }] })
      );
      expect(admitted.where).toEqual(Predicate.and(Predicate.eq("rating", 5), where));
    })
  );

  it.effect("the auth filter's own predicate is exempt: Exists and undeclared fields pass", () =>
    Effect.gen(function* () {
      const mandatory = Predicate.and(
        Predicate.exists({
          collection: "categories",
          localField: "categoryId",
          foreignField: "id",
        }),
        Predicate.eq("rating", 5)
      );
      const admitted = yield* Authorization.authorize(
        policy({ products: () => Effect.succeed(mandatory) }),
        context,
        products({ where: Predicate.eq("id", "p-1") })
      );
      expect(admitted.where).toEqual(Predicate.and(mandatory, Predicate.eq("id", "p-1")));
    })
  );

  it.effect("a server-origin subset (a named query's) is only narrowed, never checked", () =>
    Effect.gen(function* () {
      const admitted = yield* Authorization.authorize(
        policy(),
        context,
        products({ where: Predicate.eq("rating", 5) }),
        "server"
      );
      expect(admitted.where).toEqual(Predicate.and(Predicate.always, Predicate.eq("rating", 5)));
    })
  );

  it.effect("a collection the registry does not know is closed to id", () =>
    Effect.gen(function* () {
      const misc = policy({ misc: Authorization.allowAll });
      yield* Authorization.authorize(
        misc,
        context,
        Subset.make({ collection: "misc", where: Predicate.eq("id", "m-1") })
      );
      const error = yield* denied(
        Subset.make({ collection: "misc", where: Predicate.eq("colour", "red") }),
        misc
      );
      expect(error.message).toMatch(/field "colour" is not filterable \(filterable: id\)/);
    })
  );

  it.effect("a declared identity is what the filter policy admits, not the literal id", () =>
    Effect.gen(function* () {
      // `profiles` is identified by `username` (#144), so the natural-key read
      // the graph exists to enable must pass the authorization boundary with
      // no `filterable` / `sortable` declaration of its own.
      const Profile = Node.make("profiles", {
        id: "username",
        attributes: { username: Schema.String, bio: Schema.String },
      });
      const profiles = Authorization.policy(
        { profiles: Authorization.allowAll },
        { collections: Node.registry([Profile]).collections }
      );
      const byUsername = Subset.make({
        collection: "profiles",
        where: Predicate.isIn("username", ["ada"]),
        orderBy: [{ field: "username", direction: "asc" }],
      });
      expect((yield* Authorization.authorize(profiles, context, byUsername)).collection).toBe(
        "profiles"
      );
      // …and the attribute the node does NOT have is closed, rather than
      // silently privileged by the key defaults.
      const error = yield* denied(
        Subset.make({ collection: "profiles", where: Predicate.eq("id", "ada") }),
        profiles
      );
      expect(error.message).toMatch(/field "id" is not filterable \(filterable: username\)/);
      const unsortable = yield* denied(
        Subset.make({ collection: "profiles", orderBy: [{ field: "id", direction: "asc" }] }),
        profiles
      );
      expect(unsortable.message).toMatch(/field "id" is not sortable \(sortable: username\)/);
    })
  );

  it.effect("a policy built without collections keeps the open surface", () =>
    Effect.gen(function* () {
      const open = Authorization.policy({ products: Authorization.allowAll });
      const admitted = yield* Authorization.authorize(
        open,
        context,
        products({ where: Predicate.eq("rating", 5) })
      );
      expect(admitted.collection).toBe("products");
    })
  );
});

// ─── On the server: pull and read fail before Backend.evaluate ───────────────

/** A backend that records whether `evaluate` was ever reached. */
const recordingBackend = Effect.gen(function* () {
  const evaluations = yield* Ref.make(0);
  const backend: Backend.Backend = {
    applyMutations: () => Effect.succeed({ lastMutationIds: {}, hints: [] }),
    lastMutationIds: () => Effect.succeed({}),
    rejections: () => Effect.succeed([]),
    evaluate: () => Ref.update(evaluations, (n) => n + 1).pipe(Effect.as([])),
    getRows: () => Effect.succeed([]),
  };
  return { backend, evaluations };
});

/** The `AuthorizationError` a handler failure carries (as the TransportError's cause). */
const causeOf = (error: unknown): AuthorizationError => {
  const transport = error as TransportError;
  expect(transport._tag).toBe("TransportError");
  const cause = transport.cause as AuthorizationError;
  expect(cause._tag).toBe("AuthorizationError");
  return cause;
};

describe("FilterPolicy: on SyncServer", () => {
  it.effect("an inadmissible subscription fails the pull before Backend.evaluate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, evaluations } = yield* recordingBackend;
        const server = yield* Server.make({ backend, auth: { policy: policy() } });
        const pull = (where: Predicate.Predicate, orderBy: ReadonlyArray<Subset.OrderBy> = []) =>
          server.handler.handlePull({
            clientGroupId: "g",
            subscriptions: [
              products({ where: Predicate.eq("id", "p-1") }),
              products({ where, orderBy }),
            ],
          });

        const cases: ReadonlyArray<readonly [Predicate.Predicate, RegExp]> = [
          [Predicate.eq("rating", 5), /field "rating" is not filterable/],
          [Predicate.gt("name", "a"), /field "name" is not filterable with "gt"/],
          [Predicate.eq("name", 5), /does not match its kind "text"/],
          [
            Predicate.exists({
              collection: "categories",
              localField: "categoryId",
              foreignField: "id",
            }),
            /"Exists" is not allowed/,
          ],
        ];
        for (const [where, pattern] of cases) {
          const error = yield* Effect.flip(pull(where));
          expect(causeOf(error).message).toMatch(pattern);
        }
        const unsortable = yield* Effect.flip(
          pull(Predicate.always, [{ field: "priceCents", direction: "asc" }])
        );
        expect(causeOf(unsortable).message).toMatch(/not sortable/);
        // Nothing reached the backend, not even the admissible sibling subset.
        expect(yield* Ref.get(evaluations)).toBe(0);

        // The admissible subscription alone is evaluated.
        const response = yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: [products({ where: Predicate.eq("id", "p-1") })],
        });
        expect(response.patch).toEqual([]);
        expect(yield* Ref.get(evaluations)).toBe(1);
      })
    )
  );

  it.effect("a read request is checked the same way", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, evaluations } = yield* recordingBackend;
        const server = yield* Server.make({ backend, auth: { policy: policy() } });
        const error = yield* Effect.flip(
          server.handler.handleRead({
            clientGroupId: "g",
            subsets: [products({ where: Predicate.eq("rating", 5) })],
          })
        );
        expect(causeOf(error).message).toMatch(/field "rating" is not filterable/);
        expect(yield* Ref.get(evaluations)).toBe(0);

        const response = yield* server.handler.handleRead({
          clientGroupId: "g",
          subsets: [products({ where: Predicate.eq("categoryId", "c-1") })],
        });
        expect(response.rows).toEqual([]);
        expect(yield* Ref.get(evaluations)).toBe(1);
      })
    )
  );

  it.effect("the auth filter and a named query's resolved subset are exempt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, evaluations } = yield* recordingBackend;
        const topRated = Query.named("products/topRated", Schema.Struct({ min: Schema.Number }));
        const server = yield* Server.make({
          backend,
          auth: {
            policy: policy({
              products: () =>
                Effect.succeed(
                  Predicate.exists({
                    collection: "categories",
                    localField: "categoryId",
                    foreignField: "id",
                  })
                ),
              categories: Authorization.allowAll,
            }),
          },
          queries: Query.resolver([
            {
              query: topRated,
              // Server-authored: filters a field no client may filter.
              server: (args) =>
                Effect.succeed(products({ where: Predicate.gte("rating", args.min) })),
            },
          ]),
        });
        yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: [products({ where: Predicate.eq("id", "p-1") })],
          namedSubscriptions: [{ name: "products/topRated", args: { min: 4 } }],
        });
        expect(yield* Ref.get(evaluations)).toBe(2);
      })
    )
  );

  it.effect("what middleware ANDs into a subset is server-authored: checked before rewrite", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, evaluations } = yield* recordingBackend;
        // A tenancy middleware scoping every window by a field no client may
        // filter, with a relational test on read.
        const tenant = Predicate.eq("rating", 5);
        const membership = Predicate.exists({
          collection: "categories",
          localField: "categoryId",
          foreignField: "id",
        });
        const middleware: Authorization.SyncMiddleware = {
          onPush: (_context, request) => Effect.succeed(request),
          onPull: (_context, request) =>
            Effect.succeed({
              ...request,
              subscriptions: request.subscriptions.map((subset) => ({
                ...subset,
                where: Predicate.and(tenant, subset.where),
              })),
            }),
          onRead: (_context, request) =>
            Effect.succeed({
              ...request,
              subsets: request.subsets.map((subset) => ({
                ...subset,
                where: Predicate.and(membership, subset.where),
              })),
            }),
        };
        const server = yield* Server.make({ backend, auth: { policy: policy() }, middleware });

        yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: [products({ where: Predicate.eq("categoryId", "c-1") })],
        });
        yield* server.handler.handleRead({
          clientGroupId: "g",
          subsets: [products({ where: Predicate.eq("categoryId", "c-1") })],
        });
        expect(yield* Ref.get(evaluations)).toBe(2);

        // The client's own text is still checked.
        const error = yield* Effect.flip(
          server.handler.handlePull({
            clientGroupId: "g",
            subscriptions: [products({ where: Predicate.eq("rating", 5) })],
          })
        );
        expect(causeOf(error).message).toMatch(/field "rating" is not filterable/);
        expect(yield* Ref.get(evaluations)).toBe(2);
      })
    )
  );

  it.effect("a declared subscription still syncs end to end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const productSet = Mutator.make("product/set", Schema.Unknown);
        const backend = yield* MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(productSet, (args, writer) =>
              writer.put("products", (args as { id: string }).id, args)
            ),
          ])
        );
        const server = yield* Server.make({ backend, auth: { policy: policy() } });
        yield* server.handler.handlePush({
          clientGroupId: "writer",
          mutations: [
            {
              clientId: "w",
              mutationId: 1,
              mutator: "product/set",
              args: { id: "p-1", name: "Amp", categoryId: "c-1", priceCents: 100 },
              createdAt: 0,
            },
            {
              clientId: "w",
              mutationId: 2,
              mutator: "product/set",
              args: { id: "p-2", name: "Cable", categoryId: "c-2", priceCents: 5 },
              createdAt: 0,
            },
          ],
        });
        const response = yield* server.handler.handlePull({
          clientGroupId: "reader",
          subscriptions: [
            products({
              where: Predicate.and(
                Predicate.eq("categoryId", "c-1"),
                Predicate.lte("priceCents", 100)
              ),
              orderBy: [{ field: "name", direction: "asc" }],
            }),
          ],
        });
        expect(response.patch.map((op) => (op._tag === "Put" ? op.id : op._tag))).toEqual(["p-1"]);
      })
    )
  );
});
