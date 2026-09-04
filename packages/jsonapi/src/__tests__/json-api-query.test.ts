/**
 * JsonApiQuery tests (#161): the filter AST ⇄ `Predicate` bridge, the exact
 * encoder (every operator reaches the wire; nothing is dropped), URL →
 * `Query.Read` parsing over a node graph with `QueryError`s naming the
 * parameter, and the canonical string round trip over generated reads.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Random, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Filter } from "@thomasfosterau/effect-jsonapi";
import {
  Client,
  Edge,
  FilterPolicy,
  Mutator,
  Node,
  Predicate,
  Query,
  QueryError,
} from "@legation/effect";
import { ClientEngine, FilterCorpus, Subset } from "@legation/effect/internal";
import * as JsonApiQuery from "../JsonApiQuery.js";
import * as JsonApiSync from "../JsonApiSync.js";

// ─── A commerce-shaped node graph, plus the harness's corpus table ──────────

const categories = Node.make("categories", {
  attributes: { name: Schema.String },
  sortable: ["name"],
});

const products = Node.make("products", {
  attributes: { name: Schema.String, description: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    variants: Edge.many("variants", { inverse: "product" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
  filterable: { name: ["eq", "in"], priceCents: ["eq", "gt", "gte", "lt", "lte"] },
  sortable: ["name", "priceCents"],
});

const variants = Node.make("variants", {
  attributes: { sku: Schema.String, stock: Schema.Number },
  edges: { product: Edge.one("products", { via: "productId" }) },
  filterable: { stock: { operators: ["eq", "gt"], kind: "integer" } },
});

const reviews = Node.make("reviews", {
  attributes: { rating: Schema.Number, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
  filterable: { createdAt: { operators: ["gt", "lt", "isnull"], kind: "instant" } },
});

/** The differential corpus's fixture table, every column filterable by the whole core and sortable. */
const corpus = Node.make("corpus", {
  attributes: {
    s: Schema.String,
    i: Schema.Number,
    d: Schema.Number,
    b: Schema.Boolean,
    t: Schema.String,
  },
  filterable: Object.fromEntries(
    FilterCorpus.corpusColumns.map((column) => [
      column.name,
      { operators: FilterPolicy.operators, kind: column.kind },
    ])
  ),
  sortable: ["s", "i", "d", "b", "t"],
});

const nodes = Node.registry([categories, products, variants, reviews, corpus]);

const parse = (url: string) => Effect.runSync(JsonApiQuery.parseRead(nodes, url));
const parseFailure = (url: string): QueryError => {
  const exit = Effect.runSyncExit(JsonApiQuery.parseRead(nodes, url));
  if (Exit.isSuccess(exit)) throw new Error(`expected ${url} to be rejected`);
  const failure = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  if (failure?._tag !== "Fail") throw new Error(`expected a failure, got ${String(exit.cause)}`);
  return failure.error;
};

// ─── Filter AST ⇄ Predicate ──────────────────────────────────────────────────

describe("JsonApiQuery.fromFilterAst / toFilterAst", () => {
  it("maps every grammar node onto its Predicate node, and back", () => {
    const ast = Filter.and(
      Filter.eq("name", "Desk"),
      Filter.gt("priceCents", 10),
      Filter.isIn("name", ["a", "b"]),
      Filter.notIn("priceCents", [1, 2]),
      Filter.isNull("createdAt"),
      Filter.isNull("createdAt", true),
      Filter.or(Filter.lte("priceCents", 5), Filter.not(Filter.ne("name", "x")))
    );
    const predicate = JsonApiQuery.fromFilterAst(ast);
    expect(predicate).toEqual(
      Predicate.and(
        Predicate.eq("name", "Desk"),
        Predicate.gt("priceCents", 10),
        Predicate.isIn("name", ["a", "b"]),
        Predicate.notIn("priceCents", [1, 2]),
        Predicate.isNull("createdAt"),
        Predicate.isNotNull("createdAt"),
        Predicate.or(Predicate.lte("priceCents", 5), Predicate.not(Predicate.ne("name", "x")))
      )
    );
    expect(Option.getOrThrow(JsonApiQuery.toFilterAst(predicate))).toEqual(ast);
  });

  it("the empty conjunction is True; a Date literal is its instant text", () => {
    expect(JsonApiQuery.fromFilterAst(Filter.and())).toEqual(Predicate.always);
    expect(JsonApiQuery.toFilterAst(Predicate.always)).toEqual(Option.some(Filter.and()));
    expect(JsonApiQuery.fromFilterAst(Filter.gt("createdAt", new Date(0)))).toEqual(
      Predicate.gt("createdAt", "1970-01-01T00:00:00.000Z")
    );
    expect(() => JsonApiQuery.fromFilterAst(Filter.eq("x", { nested: true }))).toThrow(QueryError);
  });

  it("returns None where the grammar has no form: Exists, empty lists, null literals", () => {
    const exists = Predicate.exists({
      collection: "reviews",
      localField: "id",
      foreignField: "productId",
    });
    expect(JsonApiQuery.toFilterAst(exists)).toEqual(Option.none());
    expect(JsonApiQuery.toFilterAst(Predicate.and(Predicate.eq("a", 1), exists))).toEqual(
      Option.none()
    );
    expect(JsonApiQuery.toFilterAst(Predicate.isIn("a", []))).toEqual(Option.none());
    expect(JsonApiQuery.toFilterAst(Predicate.notIn("a", []))).toEqual(Option.none());
    expect(JsonApiQuery.toFilterAst(Predicate.compare("eq", "a", null))).toEqual(Option.none());
    expect(JsonApiQuery.toFilterAst(Predicate.isIn("a", [1, null]))).toEqual(Option.none());
    // The constructors already desugar a null literal to the null test.
    expect(JsonApiQuery.toFilterAst(Predicate.eq("a", null))).toEqual(
      Option.some(Filter.isNull("a", false))
    );
  });

  it("fromFilterAst ∘ toFilterAst is the identity over the generated corpus", () => {
    const coverage = FilterCorpus.emptyCoverage();
    const predicates = Effect.runSync(
      FilterCorpus.generatePredicate(FilterCorpus.corpusColumns, undefined, coverage, 3)
        .pipe(Effect.replicateEffect(300))
        .pipe(Random.withSeed(161))
    );
    let representable = 0;
    for (const predicate of predicates) {
      const ast = JsonApiQuery.toFilterAst(predicate);
      if (Option.isNone(ast)) {
        // Only an empty list has no grammar form; the corpus never emits
        // null literals or Exists.
        expect(hasEmptyList(predicate)).toBe(true);
        continue;
      }
      representable++;
      expect(JsonApiQuery.fromFilterAst(ast.value)).toEqual(predicate);
    }
    expect(representable).toBeGreaterThan(200);
  });
});

const hasEmptyList = (predicate: Predicate.Predicate): boolean => {
  switch (predicate._tag) {
    case "In":
    case "NotIn":
      return predicate.values.length === 0;
    case "And":
    case "Or":
      return predicate.predicates.some(hasEmptyList);
    case "Not":
      return hasEmptyList(predicate.predicate);
    default:
      return false;
  }
};

describe("JsonApiQuery.foldConstants", () => {
  const FALSE = { _tag: "Or", predicates: [] } as const;

  it("folds the definite cases exactly and leaves the rest alone", () => {
    expect(JsonApiQuery.foldConstants(Predicate.isIn("a", []))).toEqual(FALSE);
    expect(JsonApiQuery.foldConstants(Predicate.notIn("a", []))).toEqual(Predicate.always);
    expect(
      JsonApiQuery.foldConstants(Predicate.and(Predicate.eq("a", 1), Predicate.isIn("b", [])))
    ).toEqual(FALSE);
    expect(
      JsonApiQuery.foldConstants(Predicate.and(Predicate.eq("a", 1), Predicate.notIn("b", [])))
    ).toEqual(Predicate.eq("a", 1));
    expect(
      JsonApiQuery.foldConstants(Predicate.or(Predicate.eq("a", 1), Predicate.isIn("b", [])))
    ).toEqual(Predicate.eq("a", 1));
    expect(
      JsonApiQuery.foldConstants(Predicate.or(Predicate.always, Predicate.eq("a", 1)))
    ).toEqual(Predicate.always);
    expect(JsonApiQuery.foldConstants(Predicate.not(Predicate.notIn("a", [])))).toEqual(FALSE);
    expect(JsonApiQuery.foldConstants(Predicate.not(Predicate.isIn("a", [])))).toEqual(
      Predicate.always
    );
    // Unknown is never folded: the null literal stays.
    const unknown = Predicate.and(Predicate.compare("eq", "a", null), Predicate.eq("b", 1));
    expect(JsonApiQuery.foldConstants(unknown)).toEqual(unknown);
  });
});

// ─── The exact encoder ───────────────────────────────────────────────────────

const encode = (where: Predicate.Predicate, orderBy: ReadonlyArray<Subset.OrderBy> = []) =>
  Effect.runSync(
    JsonApiQuery.defaultEncoder.encode(Subset.make({ collection: "t", where, orderBy }))
  );

describe("JsonApiQuery.defaultEncoder", () => {
  it("encodes eq / in conjuncts and sort in the grammar's canonical form", () => {
    expect(
      encode(Predicate.and(Predicate.eq("status", "open"), Predicate.isIn("priority", [2, 1])), [
        { field: "created", direction: "desc" },
      ])
    ).toEqual(Option.some("?filter[priority]=1%2C2&filter[status]=open&sort=-created"));
  });

  it("encodes every operator exactly instead of dropping it", () => {
    expect(encode(Predicate.gt("age", 18))).toEqual(Option.some("?filter[age][gt]=18"));
    expect(encode(Predicate.ne("age", 18))).toEqual(Option.some("?filter[age][ne]=18"));
    expect(encode(Predicate.notIn("age", [3, 1]))).toEqual(Option.some("?filter[age][nin]=1%2C3"));
    expect(encode(Predicate.isNull("age"))).toEqual(Option.some("?filter[age][isnull]=true"));
    expect(encode(Predicate.isNotNull("age"))).toEqual(Option.some("?filter[age][isnull]=false"));
    expect(encode(Predicate.eq("age", null))).toEqual(Option.some("?filter[age][isnull]=true"));
    // A one-id list keeps the operator so it decodes back as `in`.
    expect(encode(Predicate.isIn("id", ["p1"]))).toEqual(Option.some("?filter[id][in]=p1"));
    expect(encode(Predicate.eq("name", "a,b"))).toEqual(Option.some("?filter[name]=a%5C%2Cb"));
    expect(encode(Predicate.or(Predicate.eq("a", 1), Predicate.eq("b", 2)))).toEqual(
      Option.some(
        "?filter[g0][group][conjunction]=OR" +
          "&filter[c0][condition][path]=a&filter[c0][condition][operator]=eq&filter[c0][condition][value]=1&filter[c0][condition][memberOf]=g0" +
          "&filter[c1][condition][path]=b&filter[c1][condition][operator]=eq&filter[c1][condition][value]=2&filter[c1][condition][memberOf]=g0"
      )
    );
    expect(encode(Predicate.not(Predicate.eq("a", 1)))).toEqual(
      Option.some(
        "?filter[g0][group][conjunction]=NOT" +
          "&filter[c0][condition][path]=a&filter[c0][condition][operator]=eq&filter[c0][condition][value]=1&filter[c0][condition][memberOf]=g0"
      )
    );
    // A conjunct it understands rides beside the operator forms.
    expect(encode(Predicate.and(Predicate.eq("status", "open"), Predicate.gt("age", 18)))).toEqual(
      Option.some("?filter[age][gt]=18&filter[status]=open")
    );
  });

  it("folds constants: the whole collection is no filter, an empty allow-set is no request", () => {
    expect(encode(Predicate.always)).toEqual(Option.some(""));
    expect(encode(Predicate.and(Predicate.eq("a", 1), Predicate.notIn("b", [])))).toEqual(
      Option.some("?filter[a]=1")
    );
    expect(encode(Predicate.isIn("id", []))).toEqual(Option.none());
    expect(encode(Predicate.and(Predicate.eq("a", 1), Predicate.isIn("b", [])))).toEqual(
      Option.none()
    );
  });

  it("fails closed on a predicate with no URL form", () => {
    const failure = (where: Predicate.Predicate) =>
      Effect.runSync(
        JsonApiQuery.defaultEncoder
          .encode(Subset.make({ collection: "t", where }))
          .pipe(Effect.flip)
      );
    expect(
      failure(Predicate.exists({ collection: "r", localField: "id", foreignField: "tId" }))
    ).toBeInstanceOf(QueryError);
    expect(failure(Predicate.compare("gt", "a", null))).toBeInstanceOf(QueryError);
    expect(failure(Predicate.and(Predicate.eq("a", 1), Predicate.eq("a", "x")))).toMatchObject({
      parameter: "filter[a]",
    });
  });

  it("builds the whole query string in canonical family order", () => {
    expect(
      JsonApiQuery.buildQueryString({
        page: { cursor: "c", size: 10 },
        sort: [{ field: "createdAt", direction: "desc" }],
        filter: Filter.eq("status", "published"),
        fields: { articles: ["title", "body"] },
        include: ["author"],
      })
    ).toBe(
      "?include=author&fields[articles]=title%2Cbody&filter[status]=published&sort=-createdAt&page[cursor]=c&page[size]=10"
    );
    expect(JsonApiQuery.buildQueryString()).toBe("");
    expect(JsonApiQuery.buildQueryString({})).toBe("");
  });
});

// ─── The encoder reaches a server ────────────────────────────────────────────

const idParam = { params: Schema.Struct({ id: Schema.String }) };
const body = { payload: Schema.Unknown, success: Schema.Unknown };
const api = HttpApi.make("app").add(
  HttpApiGroup.make("todos")
    .add(HttpApiEndpoint.get("list", "/todos", { success: Schema.Unknown }))
    .add(HttpApiEndpoint.post("create", "/todos", body))
    .add(HttpApiEndpoint.patch("update", "/todos/:id", { ...idParam, ...body }))
    .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam))
);

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

/** Server honouring the grammar's shorthand (`filter[f]=v`, `filter[f]=a,b`, `filter[f][eq|in]`), recording URLs. */
const makeServer = (seed: ReadonlyArray<Stored>) => {
  const store = new Map(seed.map((r) => [r.id, r]));
  const requests: Array<string> = [];
  const headers = { "Content-Type": "application/vnd.api+json" };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.pathname + url.search);
      let rows = [...store.values()];
      for (const [key, value] of url.searchParams) {
        const match = key.match(/^filter\[([^\]]+)\](?:\[(eq|in)\])?$/);
        if (match === null) continue;
        const field = match[1]!;
        const allowed = value.split(",");
        rows = rows.filter((row) => allowed.includes(String(row.attributes[field])));
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ data: rows }), { status: 200, headers })
      );
    })
  );
  return { store, requests, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

describe("server-side narrowing", () => {
  it.effect("pushes the exact filter to the API and narrows the listing", () => {
    const server = makeServer([
      { type: "todos", id: "1", attributes: { status: "open" } },
      { type: "todos", id: "2", attributes: { status: "done" } },
    ]);
    const open = Subset.make({ collection: "todos", where: Predicate.eq("status", "open") });
    const none = Subset.make({ collection: "todos", where: Predicate.isIn("status", []) });

    return Effect.gen(function* () {
      const engine = yield* ClientEngine.ClientEngine;
      yield* engine.subscribe(open);
      yield* engine.subscribe(none);
      yield* engine.pull;

      expect((yield* engine.query(open)).map((r) => r.id)).toEqual(["1"]);
      expect(yield* engine.query(none)).toEqual([]);
      // The narrowing reached the server, not just the local Subset.apply;
      // the empty allow-set never became a request.
      expect(server.requests).toEqual(["/todos?filter[status]=open"]);
    }).pipe(
      Effect.provide(
        JsonApiSync.layer(api, {
          baseUrl: "http://api.test",
          clientId: "c1",
          clientGroupId: "g1",
        }).pipe(Layer.provide(server.layer))
      ),
      Effect.scoped
    );
  });
});

// ─── URL → Query.Read ────────────────────────────────────────────────────────

describe("JsonApiQuery.parseRead", () => {
  it("maps every query family onto the read, with fields[] beside it", () => {
    const parsed = parse(
      "/api/products?include=variants,category&fields[products]=name&fields[variants]=sku" +
        "&filter[categoryId]=c-1&filter[priceCents][gt]=10&sort=-name,id&page[limit]=12&page[after]=p-9"
    );
    expect(parsed).toEqual({
      read: {
        collection: "products",
        where: Predicate.and(Predicate.eq("categoryId", "c-1"), Predicate.gt("priceCents", 10)),
        include: { variants: true, category: true },
        order: ["-name", "id"],
        first: 12,
        after: "p-9",
      },
      fields: { products: ["name"], variants: ["sku"] },
    });
    // The read compiles: the plan is what the engine runs.
    expect(Query.plan(nodes, parsed.read).root.limit).toBe(12);
  });

  it("accepts the repeated include key, the group form, and a bare listing", () => {
    expect(parse("/products?include=variants&include=category").read.include).toEqual({
      variants: true,
      category: true,
    });
    expect(
      parse(
        "/products?filter[g0][group][conjunction]=OR" +
          "&filter[c0][condition][path]=name&filter[c0][condition][operator]=eq&filter[c0][condition][value]=a&filter[c0][condition][memberOf]=g0" +
          "&filter[c1][condition][path]=priceCents&filter[c1][condition][operator]=lt&filter[c1][condition][value]=5&filter[c1][condition][memberOf]=g0"
      ).read.where
    ).toEqual(Predicate.or(Predicate.eq("name", "a"), Predicate.lt("priceCents", 5)));
    expect(parse("http://shop.test/jsonapi/categories")).toEqual({
      read: { collection: "categories" },
    });
    expect(
      Effect.runSync(
        JsonApiQuery.parseParams(
          nodes,
          "reviews",
          new URLSearchParams("filter[createdAt][isnull]=true")
        )
      ).read.where
    ).toEqual(Predicate.isNull("createdAt"));
  });

  it("reads a single resource as filter[id], first 1", () => {
    expect(parse("/api/products/p-1?include=variants").read).toEqual({
      collection: "products",
      where: Predicate.eq("id", "p-1"),
      include: { variants: true },
      first: 1,
    });
    expect(parseFailure("/products/p-1?sort=name")).toMatchObject({ parameter: "sort" });
    expect(parseFailure("/nothing/here").message).toMatch(/No collection/);
  });

  it("escapes a row id through the grammar: commas and backslashes stay one literal", () => {
    expect(parse("/products/a,b").read.where).toEqual(Predicate.eq("id", "a,b"));
    expect(parse("/products/a%2Cb").read.where).toEqual(Predicate.eq("id", "a,b"));
    expect(parse("/products/a%5Cb").read.where).toEqual(Predicate.eq("id", "a\\b"));
    // The canonical string of such a read decodes back to it.
    const read: Query.Read = {
      collection: "products",
      where: Predicate.eq("id", "a,b\\c"),
      first: 1,
    };
    expect(parse(JsonApiQuery.canonical(nodes, read)).read).toEqual(read);
  });

  it("a malformed id segment is a QueryError naming the parameter, not a defect", () => {
    expect(parseFailure("/products/100%")).toMatchObject({ parameter: "id", query: "products" });
    expect(parseFailure("/products/100%").message).toMatch(/percent-encoded/);
  });

  it("reads /{type}/{id} over /{type} and rejects nested resource paths", () => {
    // An id that happens to name a node is still an id.
    expect(parse("/products/categories").read).toEqual({
      collection: "products",
      where: Predicate.eq("id", "categories"),
      first: 1,
    });
    // The spec's related-resource and relationship URLs are not reads here.
    for (const url of [
      "/products/p-1/variants",
      "/products/p-1/relationships/variants",
      "/api/products/p-1/variants?include=product",
    ]) {
      const failure = parseFailure(url);
      expect(failure).toBeInstanceOf(QueryError);
      expect(failure.message).toMatch(/Nested resource path/);
    }
  });

  it("includes a paginated edge like any other; only its window has no URL form", () => {
    // ADR-0029's worked example.
    expect(parse("/products?include=variants,reviews").read.include).toEqual({
      variants: true,
      reviews: true,
    });
    const read: Query.Read = { collection: "products", include: { reviews: true, variants: true } };
    expect(JsonApiQuery.canonical(nodes, read)).toBe("/products?include=reviews%2Cvariants");
    expect(parse(JsonApiQuery.canonical(nodes, read)).read).toEqual(read);
    expect(() =>
      JsonApiQuery.canonical(nodes, { collection: "products", include: { reviews: { first: 5 } } })
    ).toThrow(/no URL form/);
    expect(parseFailure("/products?fields[reviews]=nope")).toMatchObject({
      parameter: "fields[reviews]",
    });
  });

  it("rejects nested include paths (D1) and undeclared edges, naming the parameter", () => {
    const nested = parseFailure("/products?include=variants.product");
    expect(nested).toBeInstanceOf(QueryError);
    expect(nested.parameter).toBe("include");
    expect(nested.message).toMatch(/nested include path "variants.product"/);
    expect(parseFailure("/products?include=nope")).toMatchObject({ parameter: "include" });
    // A node without edges takes no include at all.
    expect(parseFailure("/categories?include=products")).toMatchObject({ parameter: "include" });
  });

  it("rejects undeclared fields, operators, literals, sorts and pages, naming the parameter", () => {
    const parameters = [
      "/products?filter[description]=x",
      "/products?filter[name][gt]=x",
      "/products?filter[priceCents]=abc",
      "/variants?filter[stock]=1.5",
      "/variants?filter[stock][gt]=99999999999",
      "/reviews?filter[createdAt][gt]=2026-01-01",
      "/products?filter[name]=a&filter[name]=b",
      "/products?filter=x",
      "/products?fields[products]=nope",
      "/products?fields[orders]=id",
      "/products?sort=description",
      "/products?page[limit]=0",
      "/products?page[limit]=abc",
    ].map((url) => parseFailure(url).parameter);
    expect(parameters).toEqual([
      "filter[description]",
      "filter[name][gt]",
      "filter[priceCents]",
      "filter[stock]",
      "filter[stock][gt]",
      "filter[createdAt][gt]",
      "filter[name]",
      "filter",
      "fields[products]",
      "fields[orders]",
      "sort",
      "page[limit]",
      "page[limit]",
    ]);
    expect(parseFailure("/products?filter[name][gt]=x").message).toMatch(
      /products.*filter\[name\]\[gt\]/
    );
  });
});

// ─── Query.Read → canonical string ───────────────────────────────────────────

describe("JsonApiQuery.canonical", () => {
  it("gives one string per plan, whatever the read's spelling", () => {
    expect(
      JsonApiQuery.canonical(nodes, { collection: "products", order: ["id"], first: 100 })
    ).toBe("/products?sort=id&page[limit]=100");
    const byMap = JsonApiQuery.canonical(nodes, {
      collection: "products",
      where: { categoryId: "c-audio" },
      order: ["id"],
      first: 12,
    });
    expect(byMap).toBe("/products?filter[categoryId]=c-audio&sort=id&page[limit]=12");
    expect(
      JsonApiQuery.canonical(nodes, {
        collection: "products",
        where: Predicate.and(Predicate.always, Predicate.eq("categoryId", "c-audio")),
        order: ["id"],
        first: 12,
      })
    ).toBe(byMap);
    expect(JsonApiQuery.canonical(nodes, { collection: "categories" })).toBe("/categories");
    expect(
      JsonApiQuery.canonical(nodes, { collection: "categories", where: Predicate.always })
    ).toBe("/categories");
    // The include set and a projection are unordered.
    expect(
      JsonApiQuery.canonical(
        nodes,
        { collection: "products", include: { variants: true, category: true } },
        { products: ["name", "description"] }
      )
    ).toBe("/products?include=category%2Cvariants&fields[products]=description%2Cname");
    // A predicate that is false by construction still has one form.
    expect(
      JsonApiQuery.canonical(nodes, { collection: "products", where: Predicate.isIn("id", []) })
    ).toBe("/products?filter[g0][group][conjunction]=OR");
  });

  it("applies the projection rule parseRead applies, so fields[] round-trips or fails on both sides", () => {
    const read: Query.Read = { collection: "products", include: { variants: true } };
    const fields = { variants: ["sku"], products: ["name"] };
    const url = JsonApiQuery.canonical(nodes, read, fields);
    expect(url).toBe("/products?include=variants&fields[products]=name&fields[variants]=sku");
    expect(parse(url)).toEqual({ read, fields });
    // A type the read cannot carry is refused, not dropped: the same error
    // parseRead gives for `fields[orders]=id`.
    expect(() => JsonApiQuery.canonical(nodes, read, { orders: ["id"] })).toThrow(QueryError);
    expect(() => JsonApiQuery.canonical(nodes, read, { orders: ["id"] })).toThrow(
      /fields\[orders\]/
    );
    expect(parseFailure("/products?include=variants&fields[orders]=id")).toMatchObject({
      parameter: "fields[orders]",
    });
  });

  it("refuses what the plan or the grammar refuses", () => {
    expect(() => JsonApiQuery.canonical(nodes, { collection: "nope" })).toThrow(QueryError);
    expect(() =>
      JsonApiQuery.canonical(nodes, { collection: "products", include: { nope: true } })
    ).toThrow(QueryError);
    expect(() =>
      JsonApiQuery.canonical(nodes, { collection: "products", include: { reviews: { first: 5 } } })
    ).toThrow(/no URL form/);
    expect(() =>
      JsonApiQuery.canonical(nodes, { collection: "products", where: { description: "x" } })
    ).toThrow(/Unknown filter field "description"/);
    expect(() =>
      JsonApiQuery.canonical(nodes, {
        collection: "products",
        where: Predicate.exists({
          collection: "reviews",
          localField: "id",
          foreignField: "productId",
        }),
      })
    ).toThrow(/no URL form/);
  });

  it("round-trips: parseRead(canonical(read)) is the read, over generated reads", () => {
    const coverage = FilterCorpus.emptyCoverage();
    const generated = Effect.runSync(
      Effect.all({
        predicates: FilterCorpus.generatePredicate(
          FilterCorpus.corpusColumns,
          undefined,
          coverage,
          3
        ).pipe(Effect.replicateEffect(150)),
        orderBys: FilterCorpus.generateOrderBy().pipe(Effect.replicateEffect(150)),
        firsts: Random.nextIntBetween(0, 50).pipe(Effect.replicateEffect(150)),
      }).pipe(Random.withSeed(161))
    );
    const reads: Array<Query.Read> = [];
    for (const [index, where] of generated.predicates.entries()) {
      const read: Query.Read = { collection: "corpus", where };
      const first = generated.firsts[index];
      reads.push({
        ...read,
        ...(index % 3 === 0 ? {} : { order: orderTokens(generated.orderBys[index]!) }),
        ...(first === 0 ? {} : { first }),
        ...(index % 4 === 0 ? { after: `row-${index}` } : {}),
      });
    }
    reads.push(
      {
        collection: "products",
        where: Predicate.and(Predicate.eq("categoryId", "c-1"), Predicate.gt("priceCents", 10)),
        include: { category: true, variants: true },
        order: ["-name"],
        first: 12,
        after: "p-9",
      },
      { collection: "products", where: Predicate.eq("id", "p-1"), first: 1 },
      { collection: "categories", order: ["name"] }
    );
    for (const read of reads) {
      // The first pass puts the read in the grammar's normal form (member
      // order, folded constants); from there the round trip is exact.
      const url = JsonApiQuery.canonical(nodes, read);
      const normal = parse(url).read;
      expect(JsonApiQuery.canonical(nodes, normal)).toBe(url);
      expect(parse(JsonApiQuery.canonical(nodes, normal)).read).toEqual(normal);
      // The two reads compile to one plan.
      expect(Query.plan(nodes, normal).root.collection).toBe(read.collection);
    }
    // The hand-written reads are already in normal form.
    for (const read of reads.slice(-3)) {
      expect(parse(JsonApiQuery.canonical(nodes, read)).read).toEqual(read);
    }
  });
});

const orderTokens = (orderBy: ReadonlyArray<Subset.OrderBy>): ReadonlyArray<string> =>
  orderBy.map((term) => (term.direction === "desc" ? `-${term.field}` : term.field));

// ─── The UrlReads seam ───────────────────────────────────────────────────────

describe("JsonApiQuery.urlReads (Client.subscribe(url), ADR-0029 §2, #159)", () => {
  const products = "/products?include=category%2Cvariants&filter[name]=Desk";
  const read: Query.Read = {
    collection: "products",
    where: { name: "Desk" },
    include: { variants: true, category: true },
  };
  const makeClient = Client.make({
    nodes,
    mutations: Mutator.registry([]),
    urls: JsonApiQuery.urlReads(nodes),
  });

  it.effect("subscribe(url) and subscribe(read) of one query are one subscription", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* client.subscribe(products);
        yield* client.subscribe(read);
        expect(yield* client.subscriptions).toEqual([products]);
        const verdict = yield* client.coverageOf(read);
        expect(verdict._tag === "Covered" ? verdict.url : verdict).toBe(products);
        // Both pins release one at a time; the entry lives until the last.
        yield* client.unsubscribe(read);
        expect(yield* client.subscriptions).toEqual([products]);
        yield* client.unsubscribe(products);
        expect(yield* client.subscriptions).toEqual([]);
        expect((yield* client.coverageOf(read))._tag).toBe("Uncovered");
      })
    )
  );

  it.effect("a non-canonical URL subscribes to the canonical entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        // Parameter order, the repeated include key, an API prefix, and a
        // projection — none of them changes what is subscribed.
        yield* client.subscribe(
          "/api/products?filter[name]=Desk&include=variants&include=category"
        );
        yield* client.subscribe(
          "http://shop.test/jsonapi/products?include=variants,category&filter[name]=Desk&fields[products]=name"
        );
        expect(yield* client.subscriptions).toEqual([products]);
        yield* client.unsubscribe("/products?include=category,variants&filter[name]=Desk");
        yield* client.unsubscribe("/products?filter[name]=Desk&include=category&include=variants");
        expect(yield* client.subscriptions).toEqual([]);
      })
    )
  );

  it.effect("an unknown collection or an unparsable filter fails, naming the parameter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const unknown = yield* Effect.flip(client.subscribe("/widgets"));
        expect(unknown).toBeInstanceOf(QueryError);
        expect(unknown.message).toMatch(/No collection/);
        const literal = yield* Effect.flip(client.subscribe("/products?filter[priceCents]=abc"));
        expect(literal).toMatchObject({ _tag: "QueryError", parameter: "filter[priceCents]" });
        const operator = yield* Effect.flip(client.subscribe("/products?filter[name][gt]=x"));
        expect(operator).toMatchObject({ _tag: "QueryError", parameter: "filter[name][gt]" });
        const edge = yield* Effect.flip(client.subscribe("/products?include=nope"));
        expect(edge).toMatchObject({ _tag: "QueryError", parameter: "include" });
        // Nothing was registered by any of them.
        expect(yield* client.subscriptions).toEqual([]);
        expect((yield* client.coverageOf({ collection: "products" }))._tag).toBe("Uncovered");
      })
    )
  );

  it.effect("canonical is the seam's identity; a read with no URL form fails it", () =>
    Effect.gen(function* () {
      const urls = JsonApiQuery.urlReads(nodes);
      expect(yield* urls.canonical(read)).toBe(products);
      expect(yield* urls.parse("/api/products/p-1?include=variants")).toEqual({
        collection: "products",
        where: Predicate.eq("id", "p-1"),
        include: { variants: true },
        first: 1,
      });
      const windowed = yield* Effect.flip(
        urls.canonical({ collection: "products", include: { reviews: { first: 5 } } })
      );
      expect(windowed).toBeInstanceOf(QueryError);
      expect(windowed.message).toMatch(/no URL form/);
    })
  );
});

describe("JsonApiQuery.resourcesOf", () => {
  it("synthesises one resource per node, memoised per registry", () => {
    const resources = JsonApiQuery.resourcesOf(nodes);
    expect([...resources.keys()].toSorted()).toEqual([
      "categories",
      "corpus",
      "products",
      "reviews",
      "variants",
    ]);
    expect(JsonApiQuery.resourcesOf(nodes)).toBe(resources);
    expect(Object.keys(resources.get("products")!.relationships).toSorted()).toEqual([
      "category",
      "reviews",
      "variants",
    ]);
  });
});

describe("JsonApiQuery.querySchema", () => {
  it("is the codec parseParams decodes with: the key-field spelling, sort by id, the page window", () => {
    const schema = JsonApiQuery.querySchema(nodes, "products");
    const decoded = Schema.decodeUnknownSync(schema)({
      "filter[categoryId]": "c-audio",
      sort: "id",
      "page[limit]": "4",
      include: "variants",
    });
    expect(decoded.filter).toEqual(Filter.eq("categoryId", "c-audio"));
    expect(decoded.sort).toEqual([{ field: "id", direction: "asc" }]);
    expect(decoded.page).toEqual({ limit: 4 });
    expect(decoded.include).toEqual(["variants"]);
    // The relationship-name spelling is the resource grammar's, not the graph's.
    expect(() => Schema.decodeUnknownSync(schema)({ "filter[category]": "c-audio" })).toThrow();
    expect(() => Schema.decodeUnknownSync(schema)({ sort: "description" })).toThrow();
    expect(JsonApiQuery.querySchema(nodes, "products")).toBe(schema);
  });

  it("throws a QueryError for an unknown collection", () => {
    expect(() => JsonApiQuery.querySchema(nodes, "nope")).toThrow(QueryError);
  });
});
