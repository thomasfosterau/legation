/**
 * The unified Query read (ADR-0022, program step 3): declarative reads
 * compile to plans (Subset/Predicate as internal representation), includes
 * resolve through the node graph, per-edge `first` windows apply on the
 * resolved join, and the overloaded `Query.make` keeps the named-contract
 * form working.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Authorization,
  Backend,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Query,
  Transport,
} from "../index.js";
import { ClientEngine, ClientView, Cvr, InvalidationBus, SyncServer } from "../internal.js";
import { defined } from "./defined.js";

const Category = Node.make("categories", { attributes: { name: Schema.String } });
const Product = Node.make("products", {
  attributes: { name: Schema.String },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
});
const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const nodes = Node.registry([Category, Product, Review]);

describe("Query.plan", () => {
  it("compiles the where map, order tokens, and root window", () => {
    const compiled = Query.plan(
      nodes,
      Query.make({
        collection: "products",
        where: { categoryId: "c-1" },
        order: ["-name"],
        first: 4,
        after: "cursor-1",
      })
    );
    expect(compiled.root.collection).toBe("products");
    expect(compiled.root.where).toEqual({
      _tag: "Compare",
      op: "eq",
      field: "categoryId",
      value: "c-1",
    });
    expect(compiled.root.orderBy).toEqual([{ field: "name", direction: "desc" }]);
    expect(compiled.root.limit).toBe(4);
    expect(compiled.root.cursor).toBe("cursor-1");
  });

  it("resolves includes through the node graph, edge order included", () => {
    const compiled = Query.plan(
      nodes,
      Query.make({
        collection: "products",
        include: { category: true, reviews: { first: 2 } },
      })
    );
    expect(compiled.edges).toContainEqual({
      edge: "category",
      kind: "one",
      target: "categories",
      order: [],
    });
    expect(compiled.edges).toContainEqual({
      edge: "reviews",
      kind: "paginated",
      target: "reviews",
      first: 2,
      order: [{ field: "createdAt", direction: "desc" }],
    });
  });

  it("rejects unknown edges", () => {
    expect(() =>
      Query.plan(nodes, Query.make({ collection: "products", include: { nope: true } }))
    ).toThrow(/Unknown edge/);
  });

  it("keeps the named-contract overload working", () => {
    const contract = Query.make(
      "products/by-category",
      Schema.Struct({ categoryId: Schema.String })
    );
    expect(contract.name).toBe("products/by-category");
  });
});

// ─── Execution over a real engine ────────────────────────────────────────────

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
  const transport = yield* Transport.makeInMemory(handler, "group-read");
  return yield* ClientEngine.make({
    clientId: "client-read",
    clientGroupId: "group-read",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
});

describe("Query.run / Query.observe", () => {
  it.effect("runs a root-only read and a read with windowed includes", () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine;
      const view = ClientView.fromEngine(engine);

      yield* engine.mutate("product/set", { id: "p-1", name: "Desk", categoryId: "c-1" });
      for (const [id, at] of [
        ["r-1", "2026-01-01"],
        ["r-2", "2026-03-01"],
        ["r-3", "2026-02-01"],
      ] as const) {
        yield* engine.mutate("review/set", { id, body: id, createdAt: at, productId: "p-1" });
      }

      const plain = yield* Query.run(view, nodes, Query.make({ collection: "reviews" }));
      expect(plain).toHaveLength(3);
      expect(defined(plain[0]).related).toEqual({});

      // The paginated edge window: newest 2 reviews, in the edge's order.
      const windowed = yield* Query.run(
        view,
        nodes,
        Query.make({ collection: "products", include: { reviews: { first: 2 }, category: true } })
      );
      expect(windowed).toHaveLength(1);
      const reviews = defined(windowed[0]).related["reviews"] as ReadonlyArray<{ id: string }>;
      expect(reviews.map((row) => row.id)).toEqual(["r-2", "r-3"]);
    })
  );

  it.effect("observe re-emits when an included edge's rows change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const view = ClientView.fromEngine(engine);

        yield* engine.mutate("product/set", { id: "p-1", name: "Desk", categoryId: "c-1" });
        yield* engine.mutate("review/set", {
          id: "r-1",
          body: "first",
          createdAt: "2026-01-01",
          productId: "p-1",
        });

        const read = Query.make({ collection: "products", include: { reviews: { first: 5 } } });
        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(Query.observe(view, nodes, read), (rows) =>
            Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        yield* eventually(Ref.get(latest), (reviews) => reviews.length === 1);

        yield* engine.mutate("review/set", {
          id: "r-2",
          body: "second",
          createdAt: "2026-02-01",
          productId: "p-1",
        });
        const reviews = yield* eventually(Ref.get(latest), (rows) => rows.length === 2);
        expect(reviews.map((row) => row.id)).toEqual(["r-2", "r-1"]);
      })
    )
  );
});
