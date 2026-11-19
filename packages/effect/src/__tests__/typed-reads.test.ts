/**
 * Typed reads (#140): a read declared `as const satisfies Query.Read` keeps its
 * literal collection, include keys and order tokens; `Client.query` /
 * `Client.observe` (and `answer` / `observeAnswers`) check its names against the node graph and type its rows
 * from it (`Client.ResolvedRow`). A read the graph cannot describe statically
 * falls back to the untyped row.
 *
 * Most assertions here are compile-time: `expectTypeOf` for the types, and an
 * expect-error directive for each read that must not compile, all enforced by
 * the `check` task. One runtime test pins the shape the types describe — an
 * absent `one` edge resolves to `null`, an included `many` edge to an array.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import type * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Client from "../Client.js";
import * as Edge from "../Edge.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import * as Predicate from "../Predicate.js";
import * as Query from "../Query.js";

const categories = Node.make("categories", {
  attributes: { name: Schema.String },
  edges: { products: Edge.many("products", { inverse: "category" }) },
});
const sellers = Node.make("sellers", { id: "handle", attributes: { handle: Schema.String } });
const products = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    seller: Edge.one("sellers", { via: "sellerHandle" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-rating"] }),
  },
  sortable: ["name"],
});
const reviews = Node.make("reviews", {
  attributes: { rating: Schema.Number },
  edges: { product: Edge.one("products", { via: "productId" }) },
});

const nodes = Node.registry([categories, sellers, products, reviews]);
type Graph = typeof nodes;

type ProductRow = Node.RowOf<typeof products>;
type CategoryRow = Node.RowOf<typeof categories>;
type SellerRow = Node.RowOf<typeof sellers>;
type ReviewRow = Node.RowOf<typeof reviews>;

// ─── Declared reads ──────────────────────────────────────────────────────────

const allProducts = {
  collection: "products",
  order: ["name"],
  include: { category: true, seller: true },
} as const satisfies Query.Read;

const productDetail = (id: string) =>
  ({
    collection: "products",
    where: { id },
    include: { reviews: { first: 10 } },
  }) as const satisfies Query.Read;

const allCategories = {
  collection: "categories",
  include: { products: true },
} as const satisfies Query.Read;

const allSellers = { collection: "sellers" } as const satisfies Query.Read;

/**
 * A typed Client, for the compile-time checks: they run inside
 * {@link compileOnly}, so nothing calls it.
 */
declare const client: Client.Client<Graph>;

/** A typed Client over another graph, for the compile-time checks; never called. */
declare const clientOver: <G extends Node.NodeRegistry>(graph: G) => Client.Client<G>;

/** The type of one row a read resolves to, for `expectTypeOf`; only ever type-checked. */
declare const rowOf: <A>(effect: Effect.Effect<ReadonlyArray<A>, unknown>) => A;

/** The value an effect succeeds with, for `expectTypeOf`; only ever type-checked. */
declare const valueOf: <A>(effect: Effect.Effect<A, unknown>) => A;

/**
 * A block of compile-time assertions: type-checked by the `check` task and
 * never run, since the reads in it go to a Client that does not exist.
 */
const compileOnly = (assertions: () => void): void => {
  expect(assertions).toBeTypeOf("function");
};

describe("typed reads (#140)", () => {
  it("as const satisfies Query.Read keeps the literal collection, include keys and order", () => {
    expectTypeOf(allProducts.collection).toEqualTypeOf<"products">();
    expectTypeOf(allProducts.include).toEqualTypeOf<{
      readonly category: true;
      readonly seller: true;
    }>();
    expectTypeOf(allProducts.order).toEqualTypeOf<readonly ["name"]>();
    expectTypeOf(productDetail("p1").include.reviews).toEqualTypeOf<{ readonly first: 10 }>();
    // `Query.make` keeps the literal too.
    expectTypeOf(Query.make({ collection: "products" }).collection).toEqualTypeOf<"products">();
  });

  it("satisfies Query.Read rejects a read of the wrong shape", () => {
    // @ts-expect-error `include` values are `true` or include options
    void ({ collection: "products", include: { seller: "yes" } } as const satisfies Query.Read);
    // @ts-expect-error `first` is a number
    void ({ collection: "products", first: "10" } as const satisfies Query.Read);
    // @ts-expect-error a read has no `select`
    void ({ collection: "products", select: ["name"] } as const satisfies Query.Read);
    // @ts-expect-error a read names its collection
    void ({ include: { seller: true } } as const satisfies Query.Read);
  });

  it("types each row's value by the node and its included edges by kind", () =>
    compileOnly(() => {
      const row = rowOf(client.query(allProducts));
      expectTypeOf(row.value).toEqualTypeOf<ProductRow>();
      expectTypeOf(row.value.name).toEqualTypeOf<string>();
      expectTypeOf(row.value.categoryId).toEqualTypeOf<string & Brand.Brand<"categories/id">>();
      // `one` edges: the target row, or `null` when the referenced row is absent.
      expectTypeOf(row.related.category).toEqualTypeOf<CategoryRow | null>();
      expectTypeOf(row.related.seller).toEqualTypeOf<SellerRow | null>();
      expectTypeOf(row.related).toEqualTypeOf<{
        readonly category: CategoryRow | null;
        readonly seller: SellerRow | null;
      }>();
      // A natural-key node's row carries its own identity attribute, no synthetic `id`.
      expectTypeOf(row.related.seller?.handle).toEqualTypeOf<string | undefined>();

      // `many` and `paginated` edges: the target rows.
      const detail = rowOf(client.query(productDetail("p1")));
      expectTypeOf(detail.related.reviews).toEqualTypeOf<ReadonlyArray<ReviewRow>>();
      const withProducts = rowOf(client.query(allCategories));
      expectTypeOf(withProducts.related.products).toEqualTypeOf<ReadonlyArray<ProductRow>>();

      // A read with no `include` resolves no edges.
      const plain = rowOf(client.query(allSellers));
      expectTypeOf(plain.value).toEqualTypeOf<SellerRow>();
      expectTypeOf(plain.related).toEqualTypeOf<Record<never, never>>();
    }));

  it("an edge the read did not include is a compile error to read", () =>
    compileOnly(() => {
      const row = rowOf(client.query(allProducts));
      // @ts-expect-error `reviews` is an edge of products, but this read does not include it
      void row.related.reviews;
      const plain = rowOf(client.query(allSellers));
      // @ts-expect-error a read with no `include` resolves no edges
      void plain.related.anything;
    }));

  it("observe types its emissions as query types its rows", () =>
    compileOnly(() => {
      const stream = client.observe(allProducts);
      expectTypeOf(stream).toEqualTypeOf<
        Stream.Stream<ReadonlyArray<Client.ResolvedRow<typeof allProducts, Graph>>>
      >();
    }));

  it("answer and observeAnswers type their rows as query does, beside the completeness (#653)", () =>
    compileOnly(() => {
      const answer = valueOf(client.answer(allProducts));
      expectTypeOf(answer).toEqualTypeOf<Client.Answer<typeof allProducts, Graph>>();
      expectTypeOf(answer.rows).toEqualTypeOf<
        ReadonlyArray<Client.ResolvedRow<typeof allProducts, Graph>>
      >();
      expectTypeOf<(typeof answer.rows)[number]["value"]>().toEqualTypeOf<ProductRow>();
      expectTypeOf(answer.completeness).toEqualTypeOf<Client.Completeness>();
      expectTypeOf(client.observeAnswers(productDetail("p1"))).toEqualTypeOf<
        Stream.Stream<Client.Answer<ReturnType<typeof productDetail>, Graph>>
      >();
      // A dynamic read's answer holds untyped rows, as its query does.
      const collection: string = "products";
      expectTypeOf(valueOf(client.answer({ collection })).rows).toEqualTypeOf<
        ReadonlyArray<Client.ResolvedRow>
      >();
    }));

  it("answer and observeAnswers reject a misnamed read as query does (#653)", () =>
    compileOnly(() => {
      // @ts-expect-error "sellr" is not an edge of products
      void client.answer({ collection: "products", include: { sellr: true } });
      // @ts-expect-error "nmae" is not a field of products
      void client.observeAnswers({ collection: "products", where: { nmae: "Lamp" } });
      // @ts-expect-error "prodcts" is not a collection of the graph
      void client.answer({ collection: "prodcts" });
      const row = valueOf(client.answer(allProducts)).rows[0];
      // @ts-expect-error `reviews` is an edge of products, but this read does not include it
      void row?.related.reviews;
    }));

  it("an inline literal read is typed with no `as const`", () =>
    compileOnly(() => {
      const row = rowOf(client.query({ collection: "reviews", include: { product: true } }));
      expectTypeOf(row.related.product).toEqualTypeOf<ProductRow | null>();
    }));

  it("a misnamed collection, edge, field or order token fails to compile where it is used", () =>
    compileOnly(() => {
      const misspeltCollection = { collection: "prodcts" } as const satisfies Query.Read;
      // @ts-expect-error "prodcts" is not a collection of the graph
      void client.query(misspeltCollection);
      const misspeltEdge = {
        collection: "products",
        include: { sellr: true },
      } as const satisfies Query.Read;
      // @ts-expect-error "sellr" is not an edge of products
      void client.query(misspeltEdge);
      const misspeltField = {
        collection: "products",
        where: { nmae: "Lamp" },
      } as const satisfies Query.Read;
      // @ts-expect-error "nmae" is not a field of products
      void client.observe(misspeltField);
      const misspeltOrder = {
        collection: "products",
        order: ["-nmae"],
      } as const satisfies Query.Read;
      // @ts-expect-error "-nmae" orders by no field of products
      void client.query(misspeltOrder);
      // @ts-expect-error inline, too: "categry" is not an edge of products
      void client.query({ collection: "products", include: { categry: true } });
      // Every field of the row is nameable: identity, attributes, `one`-edge keys.
      void client.query({
        collection: "products",
        where: { id: "p1", name: "Lamp", categoryId: "c1" },
        order: ["-priceCents", "id"],
      });
    }));

  it("renaming an attribute or an edge breaks the use site", () =>
    compileOnly(() => {
      const renamed = Node.registry([
        categories,
        sellers,
        reviews,
        Node.make("products", {
          attributes: { title: Schema.String, priceCents: Schema.Number },
          edges: {
            category: Edge.one("categories", { via: "categoryId" }),
            vendor: Edge.one("sellers", { via: "sellerHandle" }),
            reviews: Edge.paginated("reviews", { inverse: "product", order: ["-rating"] }),
          },
        }),
      ]);
      const renamedClient = clientOver(renamed);
      // @ts-expect-error `seller` was renamed `vendor`: the read no longer compiles
      void renamedClient.query(allProducts);
      const row = rowOf(renamedClient.query({ collection: "products" }));
      // @ts-expect-error `name` was renamed `title`
      void row.value.name;
    }));

  it("a generic helper forwards a checked read with its type argument", () =>
    compileOnly(() => {
      // Inside the helper, `R` is already checked, so the inner call is told it
      // rather than re-inferring (and re-checking) the intersection.
      const firstOf = <const R extends Query.Read>(read: R & Query.Validate<Graph, R>) =>
        Effect.map(client.query<R>(read), (rows) => rows[0]);
      void Effect.map(firstOf(allProducts), (row) => {
        const seller: SellerRow | null | undefined = row?.related.seller;
        // @ts-expect-error the wrapper's rows carry only the included edges
        void row?.related.reviews;
        return seller;
      });
      // @ts-expect-error the helper's callers are checked like `query`'s
      void firstOf({ collection: "products", include: { sellr: true } });
    }));

  it("a dynamic read falls back to the untyped row", () =>
    compileOnly(() => {
      const collection: string = "products";
      const dynamic = { collection, include: { seller: true as const } };
      const row = rowOf(client.query(dynamic));
      expectTypeOf(row).toEqualTypeOf<Client.ResolvedRow>();
      expectTypeOf(row.value).toEqualTypeOf<unknown>();
      // An annotated read is dynamic: its literal types are widened away.
      const annotated: Query.Read = { collection: "products" };
      expectTypeOf(rowOf(client.query(annotated))).toEqualTypeOf<Client.ResolvedRow>();
      // A literal read's dynamic parts are not checked: a full predicate, a
      // `where` built at runtime, order tokens typed `string`.
      const field: string = "name";
      const where = { [field]: "Lamp" };
      const order: ReadonlyArray<string> = ["name"];
      void client.query({ collection: "products", where: Predicate.eq(field, "Lamp") });
      void client.query({ collection: "products", where, order });
      // A read whose type is a union resolves to the union of its rows.
      const either = (flag: boolean) => (flag ? allProducts : allSellers);
      const mixed = rowOf(client.query(either(true)));
      expectTypeOf(mixed.value).toEqualTypeOf<ProductRow | SellerRow>();
    }));

  it("a Client over an erased graph accepts any read and resolves untyped rows", () =>
    compileOnly(() => {
      const erased: Client.Client = client;
      const row = rowOf(erased.query({ collection: "anything", include: { edge: true } }));
      expectTypeOf(row).toEqualTypeOf<Client.ResolvedRow>();
      // `ResolvedRow` over the registered graph (none in this program) is untyped.
      expectTypeOf<Client.ResolvedRow<typeof allProducts>>().toEqualTypeOf<Client.ResolvedRow>();
      expectTypeOf<Client.Registered>().toEqualTypeOf<Node.NodeRegistry>();
      // So is an erased Client's answer, and `Answer` over the registered graph.
      expectTypeOf(valueOf(erased.answer({ collection: "anything" })).rows).toEqualTypeOf<
        ReadonlyArray<Client.ResolvedRow>
      >();
      expectTypeOf<Client.Answer<typeof allProducts>>().toEqualTypeOf<Client.Answer>();
    }));

  it.effect("resolves an absent `one` edge to null and an included `many` edge to an array", () =>
    Effect.gen(function* () {
      const mutations = Mutator.registry([
        {
          mutator: Mutator.make(
            "put",
            Schema.Struct({ collection: Schema.String, id: Schema.String, value: Schema.Unknown })
          ),
          local: ({ collection, id, value }, writer) => writer.put(collection, id, value),
        },
      ]);
      const { client: local } = yield* Client.make({ nodes, mutations, sync: false });
      yield* local.mutate("put", {
        collection: "categories",
        id: "c1",
        value: { id: "c1", name: "Audio" },
      });
      yield* local.mutate("put", {
        collection: "products",
        id: "p1",
        value: { id: "p1", name: "Lamp", priceCents: 100, categoryId: "c1", sellerHandle: "gone" },
      });
      const [product] = yield* local.query(allProducts);
      expect(product?.value.name).toBe("Lamp");
      expect(product?.related.category?.name).toBe("Audio");
      expect(product?.related.seller).toBeNull();
      const [category] = yield* local.query(allCategories);
      expect(category?.related.products.map((row) => row.name)).toEqual(["Lamp"]);
    }).pipe(Effect.scoped)
  );
});
