/**
 * Coverage (ADR-0029 section 3, issue #162): the two worked tables of the
 * ADR as unit tests, then each rule on its own — canonical conjuncts under
 * structural equality, the strict window (a cursor alone included), the
 * include rule over a plan's edge selects — and the deliberate false
 * negatives (full implication is not built).
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { Edge, Node, Predicate, Query } from "../index.js";
import { Coverage, Subset } from "../internal.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String, categoryId: Schema.String },
  edges: {
    variants: Edge.many("variants", { inverse: "product" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
});
const Variant = Node.make("variants", {
  attributes: { sku: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const Category = Node.make("categories", { attributes: { name: Schema.String } });
const nodes = Node.registry([Product, Variant, Review, Category]);

/** A read as the registration coverage compares: its root window and edge selects. */
const registration = (read: Query.Read): Coverage.Registration =>
  Coverage.ofPlan(Query.plan(nodes, read));

const coversRead = (subscribed: Query.Read, requested: Query.Read): boolean =>
  Coverage.coversRegistration(registration(subscribed), registration(requested));

const products = (options: Partial<Query.Read> = {}): Query.Read => ({
  collection: "products",
  ...options,
});

describe("worked example: an unwindowed subscription (GET /products?include=variants)", () => {
  const subscribed = products({ include: { variants: true } });

  it("1. GET /products: same collection, empty conjunct set, no window — local", () => {
    expect(coversRead(subscribed, products())).toBe(true);
  });

  it("2. filter[categoryId]=c-audio: the extra conjunct filters locally — local", () => {
    expect(coversRead(subscribed, products({ where: { categoryId: "c-audio" } }))).toBe(true);
  });

  it("3. sort=name&page[limit]=12: an unwindowed subscription covers any window — local", () => {
    expect(coversRead(subscribed, products({ order: ["name"], first: 12 }))).toBe(true);
  });

  it("4. include=variants,reviews: the reviews edge was not registered — network", () => {
    expect(coversRead(subscribed, products({ include: { variants: true, reviews: true } }))).toBe(
      false
    );
  });

  it("5. GET /products/p-1 is filter[id]=p-1, first 1: conjunct local, window ok — local", () => {
    expect(coversRead(subscribed, products({ where: { id: "p-1" }, first: 1 }))).toBe(true);
  });

  it("6. GET /categories: a different collection — network", () => {
    expect(coversRead(subscribed, { collection: "categories" })).toBe(false);
  });
});

describe("worked example: a windowed subscription (GET /products?sort=name&page[limit]=100)", () => {
  const subscribed = products({ order: ["name"], first: 100 });

  it("1. sort=name&page[limit]=12: a prefix of the synced window — local", () => {
    expect(coversRead(subscribed, products({ order: ["name"], first: 12 }))).toBe(true);
  });

  it("2. filter[categoryId]=c-audio&sort=name&page[limit]=12: strict window — network", () => {
    expect(
      coversRead(
        subscribed,
        products({ where: { categoryId: "c-audio" }, order: ["name"], first: 12 })
      )
    ).toBe(false);
  });

  it("3. sort=-name&page[limit]=12: the synced prefix is of another order — network", () => {
    expect(coversRead(subscribed, products({ order: ["-name"], first: 12 }))).toBe(false);
  });

  it("the commerce shell: productPage({}) is local, productPage({ categoryId }) falls through", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(coversRead(shell, products({ order: ["id"], first: 12 }))).toBe(true);
    expect(
      coversRead(shell, products({ where: { categoryId: "c-audio" }, order: ["id"], first: 12 }))
    ).toBe(false);
  });
});

describe("rule 2: the window", () => {
  const windowed = Subset.make({
    collection: "products",
    orderBy: [{ field: "name", direction: "asc" }],
    limit: 100,
  });
  const at = (options: Partial<Subset.Subset>): Subset.Subset => ({ ...windowed, ...options });

  it("a limit, a cursor, or both is a window; neither is not", () => {
    expect(Coverage.isWindowed(Subset.make({ collection: "products" }))).toBe(false);
    expect(Coverage.isWindowed(Subset.make({ collection: "products", limit: 1 }))).toBe(true);
    expect(Coverage.isWindowed(Subset.make({ collection: "products", cursor: "p-50" }))).toBe(true);
    expect(Coverage.isWindowed(Query.plan(nodes, products({ after: "p-50" })).root)).toBe(true);
  });

  it("a windowed subscription never covers an unwindowed request", () => {
    expect(Coverage.coversWindow(windowed, at({ limit: undefined }))).toBe(false);
  });

  it("the same limit is a prefix; a larger one is not", () => {
    expect(Coverage.coversWindow(windowed, at({ limit: 100 }))).toBe(true);
    expect(Coverage.coversWindow(windowed, at({ limit: 101 }))).toBe(false);
  });

  it("the cursor must be the same (both absent, or equal)", () => {
    expect(Coverage.coversWindow(windowed, at({ cursor: "p-5" }))).toBe(false);
    const fromCursor = at({ cursor: "p-5" });
    expect(Coverage.coversWindow(fromCursor, { ...fromCursor, limit: 10 })).toBe(true);
    expect(Coverage.coversWindow(fromCursor, { ...fromCursor, cursor: "p-6" })).toBe(false);
    expect(Coverage.coversWindow(fromCursor, { ...fromCursor, cursor: undefined })).toBe(false);
  });

  it("a cursor without a limit is a window: after p-50 does not hold the whole collection", () => {
    const afterCursor = Query.plan(nodes, products({ after: "p-50" })).root;
    const whole = Query.plan(nodes, products()).root;
    expect(Coverage.covers(afterCursor, whole)).toBe(false);
    expect(Coverage.covers(afterCursor, { ...whole, cursor: "p-51" })).toBe(false);
    expect(
      Coverage.covers(afterCursor, { ...whole, orderBy: [{ field: "name", direction: "asc" }] })
    ).toBe(false);
    // The identical window, with any limit, is held: every row after the cursor synced.
    expect(Coverage.covers(afterCursor, afterCursor)).toBe(true);
    expect(Coverage.covers(afterCursor, { ...afterCursor, limit: 12 })).toBe(true);
    // A narrower predicate over the cursor is strict, like any window.
    expect(
      Coverage.covers(afterCursor, { ...afterCursor, where: Predicate.eq("categoryId", "c-audio") })
    ).toBe(false);
    // The whole collection covers the cursored read.
    expect(Coverage.covers(whole, afterCursor)).toBe(true);
  });

  it("the order must deep-equal: field, direction and term count", () => {
    expect(
      Coverage.coversWindow(windowed, at({ orderBy: [{ field: "name", direction: "desc" }] }))
    ).toBe(false);
    expect(
      Coverage.coversWindow(windowed, at({ orderBy: [{ field: "id", direction: "asc" }] }))
    ).toBe(false);
    expect(
      Coverage.coversWindow(
        windowed,
        at({
          orderBy: [
            { field: "name", direction: "asc" },
            { field: "id", direction: "asc" },
          ],
        })
      )
    ).toBe(false);
  });

  it("an unwindowed subscription covers any window", () => {
    const whole = Subset.make({ collection: "products" });
    expect(Coverage.coversWindow(whole, at({ cursor: "p-5", limit: 3 }))).toBe(true);
    expect(Coverage.coversWindow(whole, whole)).toBe(true);
  });
});

describe("offset pagination (#209): covered by the ordinary limit-prefix rule", () => {
  // Option A of #209: an offset read compiles (`Query.plan`'s `rootLimit`)
  // to a plain limit-only window — `limit = offset + first`, no `cursor` —
  // so it is judged by exactly `coversWindow`/rule 2 above; no parallel
  // "offset coverage" path exists. Option B (offset windows as a
  // subscription's own identity) was rejected: an insert before the window
  // would shift every row, and ADR-0024 chose cursors for the engine's
  // sync windows deliberately.

  it("an unwindowed subscription covers any offset, any limit", () => {
    expect(coversRead(products(), products({ offset: 88, first: 12 }))).toBe(true);
    expect(coversRead(products(), products({ offset: 10_000, first: 12 }))).toBe(true);
  });

  it("a windowed subscription covers offset+first at most its own limit", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(coversRead(shell, products({ order: ["id"], offset: 88, first: 12 }))).toBe(true);
    expect(coversRead(shell, products({ order: ["id"], offset: 90, first: 10 }))).toBe(true);
  });

  it("an offset beyond the synced window is uncovered — falls through, never fetched deeper", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(coversRead(shell, products({ order: ["id"], offset: 89, first: 12 }))).toBe(false);
    expect(coversRead(shell, products({ order: ["id"], offset: 500, first: 1 }))).toBe(false);
  });

  it("the order must still match: an offset page of another sort is not the synced order", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(coversRead(shell, products({ order: ["name"], offset: 0, first: 12 }))).toBe(false);
  });

  it("a narrower predicate over a windowed subscription is still strict under offset", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(
      coversRead(
        shell,
        products({ where: { categoryId: "c-audio" }, order: ["id"], offset: 0, first: 12 })
      )
    ).toBe(false);
  });

  it("offset without a limit is unwindowed (fetch every row past offset): only an unwindowed subscription covers it", () => {
    const shell = products({ order: ["id"], first: 100 });
    expect(coversRead(products(), products({ order: ["id"], offset: 10 }))).toBe(true);
    expect(coversRead(shell, products({ order: ["id"], offset: 10 }))).toBe(false);
  });

  it("offset and cursor are different window identities: a cursored subscription never covers an offset request", () => {
    const cursored = products({ order: ["id"], after: "p-50" });
    expect(coversRead(cursored, products({ order: ["id"], offset: 0, first: 12 }))).toBe(false);
  });
});

describe("rule 3: canonical conjuncts", () => {
  const keys = (predicate: Predicate.Predicate) =>
    Coverage.canonicalConjuncts(predicate).map((conjunct) => conjunct.key);

  it("an absent where, True and an empty And canonicalise to the empty set", () => {
    expect(keys(Predicate.always)).toEqual([]);
    expect(keys(Predicate.and())).toEqual([]);
    expect(keys(Query.plan(nodes, products()).root.where)).toEqual([]);
    expect(keys(Predicate.and(Predicate.always, Predicate.and()))).toEqual([]);
  });

  it("each conjunct carries its member and its key, sorted by key", () => {
    const a = Predicate.eq("categoryId", "c-audio");
    const b = Predicate.gt("priceCents", 100);
    const conjuncts = Coverage.canonicalConjuncts(Predicate.and(b, a));
    expect(conjuncts.map((conjunct) => conjunct.predicate)).toEqual([a, b]);
    expect(conjuncts.map((conjunct) => conjunct.key)).toEqual([
      Coverage.structuralKey(a),
      Coverage.structuralKey(b),
    ]);
  });

  it("flattens nested And and sorts structurally, so member order is irrelevant", () => {
    const a = Predicate.eq("categoryId", "c-audio");
    const b = Predicate.gt("priceCents", 100);
    const c = Predicate.isNull("sellerId");
    expect(keys(Predicate.and(a, Predicate.and(b, c)))).toEqual(keys(Predicate.and(c, b, a)));
    expect(keys(Predicate.and(a, a, b))).toEqual(keys(Predicate.and(b, a)));
  });

  it("In and NotIn literal lists compare in canonical order, duplicates dropped", () => {
    expect(Coverage.structuralKey(Predicate.isIn("id", ["b", "a", "a"]))).toBe(
      Coverage.structuralKey(Predicate.isIn("id", ["a", "b"]))
    );
    expect(Coverage.structuralKey(Predicate.notIn("id", [2, 1]))).toBe(
      Coverage.structuralKey(Predicate.notIn("id", [1, 2]))
    );
    expect(Coverage.structuralKey(Predicate.isIn("id", [1]))).not.toBe(
      Coverage.structuralKey(Predicate.notIn("id", [1]))
    );
  });

  it("literals are typed: the same operator, field and text of different types differ", () => {
    expect(Coverage.structuralKey(Predicate.eq("n", "1"))).not.toBe(
      Coverage.structuralKey(Predicate.eq("n", 1))
    );
    expect(Coverage.structuralKey(Predicate.eq("n", "true"))).not.toBe(
      Coverage.structuralKey(Predicate.eq("n", true))
    );
    expect(Coverage.structuralKey(Predicate.eq("n", 1))).not.toBe(
      Coverage.structuralKey(Predicate.ne("n", 1))
    );
  });

  it("IsNull with negated false keys as IsNull without it", () => {
    expect(Coverage.structuralKey({ _tag: "IsNull", field: "f", negated: false })).toBe(
      Coverage.structuralKey(Predicate.isNull("f"))
    );
    expect(Coverage.structuralKey(Predicate.isNotNull("f"))).not.toBe(
      Coverage.structuralKey(Predicate.isNull("f"))
    );
  });

  it("Or and Not are whole conjuncts: equal structurally, nothing inferred through them", () => {
    const a = Predicate.eq("categoryId", "c-audio");
    const b = Predicate.eq("categoryId", "c-video");
    expect(Coverage.structuralKey(Predicate.or(a, b))).toBe(
      Coverage.structuralKey(Predicate.or(b, a))
    );
    // The same Or as a whole conjunct is covered ...
    expect(Coverage.subsumes(Predicate.or(a, b), Predicate.and(Predicate.or(b, a), a))).toBe(true);
    // ... but a branch of it is not, even though it implies the Or.
    expect(Coverage.subsumes(Predicate.or(a, b), a)).toBe(false);
    expect(Coverage.subsumes(Predicate.not(a), Predicate.and(Predicate.not(a), b))).toBe(true);
    expect(Coverage.subsumes(Predicate.not(a), b)).toBe(false);
  });

  it("an Exists node compares as a whole conjunct", () => {
    const exists = Predicate.exists({
      collection: "variants",
      localField: "id",
      foreignField: "productId",
      where: Predicate.gt("stock", 0),
    });
    expect(Coverage.subsumes(exists, Predicate.and(exists, Predicate.eq("name", "Desk")))).toBe(
      true
    );
    expect(Coverage.subsumes(exists, Predicate.eq("name", "Desk"))).toBe(false);
  });

  it("subsumes is subset; sameConjuncts is equality", () => {
    const a = Predicate.eq("categoryId", "c-audio");
    const b = Predicate.gt("priceCents", 100);
    expect(Coverage.subsumes(a, Predicate.and(a, b))).toBe(true);
    expect(Coverage.subsumes(Predicate.and(a, b), a)).toBe(false);
    expect(Coverage.sameConjuncts(Predicate.and(a, b), Predicate.and(b, a))).toBe(true);
    expect(Coverage.sameConjuncts(a, Predicate.and(a, b))).toBe(false);
  });

  it("full implication is deliberately not built", () => {
    expect(Coverage.subsumes(Predicate.lt("price", 20), Predicate.lt("price", 10))).toBe(false);
    expect(Coverage.subsumes(Predicate.isIn("id", ["a", "b"]), Predicate.isIn("id", ["a"]))).toBe(
      false
    );
    expect(Coverage.subsumes(Predicate.isIn("id", ["a", "b"]), Predicate.eq("id", "a"))).toBe(
      false
    );
  });

  it("under a windowed subscription the conjunct sets must be the same", () => {
    const a = Predicate.eq("categoryId", "c-audio");
    const windowed = Subset.make({
      collection: "products",
      where: a,
      orderBy: [{ field: "id", direction: "asc" }],
      limit: 100,
    });
    const narrower = Predicate.and(a, Predicate.gt("priceCents", 100));
    expect(Coverage.covers(windowed, { ...windowed, limit: 12 })).toBe(true);
    expect(Coverage.covers(windowed, { ...windowed, where: narrower, limit: 12 })).toBe(false);
    const cursored = { ...windowed, limit: undefined, cursor: "p-50" };
    expect(Coverage.covers(cursored, { ...cursored, limit: 12 })).toBe(true);
    expect(Coverage.covers(cursored, { ...cursored, where: narrower })).toBe(false);
    expect(Coverage.covers({ ...windowed, limit: undefined }, { ...windowed, limit: 12 })).toBe(
      true
    );
  });
});

describe("rule 4: includes over the plan's edge selects", () => {
  it("every requested edge must be among the subscription's selects", () => {
    expect(coversRead(products({ include: { variants: true, reviews: true } }), products())).toBe(
      true
    );
    expect(
      coversRead(
        products({ include: { variants: true, reviews: true } }),
        products({ include: { reviews: true } })
      )
    ).toBe(true);
    expect(coversRead(products(), products({ include: { variants: true } }))).toBe(false);
  });

  it("a paginated edge's first is at most the subscription's, or the select is unwindowed", () => {
    const windowedEdge = products({ include: { reviews: { first: 2 } } });
    expect(coversRead(windowedEdge, products({ include: { reviews: { first: 1 } } }))).toBe(true);
    expect(coversRead(windowedEdge, products({ include: { reviews: { first: 2 } } }))).toBe(true);
    expect(coversRead(windowedEdge, products({ include: { reviews: { first: 3 } } }))).toBe(false);
    expect(coversRead(windowedEdge, products({ include: { reviews: true } }))).toBe(false);
    const wholeEdge = products({ include: { reviews: true } });
    expect(coversRead(wholeEdge, products({ include: { reviews: { first: 50 } } }))).toBe(true);
  });
});

describe("covering across a ledger", () => {
  it("returns the first covering subscription in iteration order, or undefined", () => {
    const shell = registration(products({ order: ["id"], first: 100 }));
    const whole = registration(products());
    const audio = registration(products({ where: { categoryId: "c-audio" } }));
    const page = registration(
      products({ where: { categoryId: "c-audio" }, order: ["id"], first: 12 })
    );
    expect(Coverage.covering([shell], page)).toBeUndefined();
    expect(Coverage.covering([shell, whole], page)).toBe(whole);
    // Both cover; the earlier registration wins, an exact match notwithstanding.
    expect(Coverage.covering([whole, audio], audio)).toBe(whole);
    expect(Coverage.covering([audio, whole], audio)).toBe(audio);
    expect(Coverage.covering([], page)).toBeUndefined();
  });
});
