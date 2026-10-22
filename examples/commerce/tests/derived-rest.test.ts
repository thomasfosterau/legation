/**
 * The commerce JSON:API's reads are derived (#163, #165): every `list` /
 * `get` in `server/jsonapi.ts` is `RestHandlers` over the app's node graph,
 * its backend and its auth policy, so this file is the phase-1 stack end to
 * end — the grammar in the URL, the read path, the auth policy, the
 * serialiser — on the app's own seed.
 *
 * Three things are pinned:
 *
 * 1. **The documents.** Each read the app makes (`src/lib/domain.ts`), at
 *    the canonical URL the SvelteKit loads fetch it by, against a committed
 *    fixture (`fixtures/rest/<read>.json`) — what #163's comparison with the
 *    hand-written handlers turned into once those were deleted. Regenerate
 *    with `COMMERCE_FIXTURES=write pnpm run test` and review the diff.
 * 2. **The declarations agree.** `src/lib/resources.ts` bridged through
 *    `NodeBridge.registry` is the hand-written graph of `src/lib/domain.ts`,
 *    node for node: attributes, edges, the filterable set, the sortable
 *    fields, the hint keys.
 * 3. **The tier's own promises.** Scoping is the policy's (anonymous reads
 *    of a private collection are empty, no `WHERE userId` anywhere); a URL
 *    the grammar rejects — an undeclared field, a literal of the wrong kind,
 *    an unsortable field, an edge no node has — is a 400 error document with
 *    `source.parameter`, before any backend call; `fields[]` projects at
 *    serialisation over full rows; paging is `Subset.apply`'s cursor window,
 *    continued by `links.next`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonApiQuery, NodeBridge } from "@thomasfosterau/legation-jsonapi";
import type { Node, Query } from "@thomasfosterau/legation-effect";
import {
  allCategories,
  allVariants,
  myCartItems,
  myOrderItems,
  myOrders,
  nodes,
  productDetail,
  productPage,
  productReviews,
} from "../src/lib/domain.js";
import { resources } from "../src/lib/resources.js";
import { type Json, makeWorld } from "./support/world.js";

// ─── 1. The documents: the app's reads against committed fixtures ────────────

/** The app's reads, each with the identity it is made under. */
const reads: ReadonlyArray<{ readonly name: string; readonly read: Query.Read; readonly user?: string }> =
  [
    { name: "all-categories", read: allCategories },
    { name: "all-variants", read: allVariants },
    { name: "product-page", read: productPage({}) },
    { name: "product-page-keyboards", read: productPage({ categoryId: "c-keyboards" }) },
    { name: "product-page-after-p-04", read: productPage({ cursor: "p-04" }) },
    { name: "product-detail-p-01", read: productDetail("p-01") },
    { name: "product-reviews-p-01", read: productReviews("p-01") },
    { name: "my-cart-items-u1", read: myCartItems("u1"), user: "u1" },
    { name: "my-orders-u1", read: myOrders("u1"), user: "u1" },
    { name: "my-order-items-u1", read: myOrderItems("u1"), user: "u1" },
  ];

const fixturesDir = fileURLToPath(new URL("./fixtures/rest/", import.meta.url));

/** The committed document of a route, written when `COMMERCE_FIXTURES=write`. */
const fixture = (name: string, actual: Json): Json => {
  const path = `${fixturesDir}${name}.json`;
  if (process.env.COMMERCE_FIXTURES === "write") {
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
  }
  if (!existsSync(path)) {
    throw new Error(`no fixture ${path} — run with COMMERCE_FIXTURES=write to create it`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
};

describe("the app's reads, at their canonical URLs, against the committed fixtures", () => {
  for (const { name, read, user } of reads) {
    it.effect(name, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const url = `/jsonapi${JsonApiQuery.canonical(nodes, read)}`;
          const { status, body } = yield* world.get(url, user);
          expect(status).toBe(200);
          expect(body.data).not.toEqual([]);
          // `links.self` is the request's own canonical string: the load's URL
          // is the subscription identity a tab would use (ADR-0029 §2).
          expect(body.links.self).toBe(url);
          expect({ url, user, status, body }).toEqual(fixture(name, { url, user, status, body }));
        })
      )
    );
  }

  it.effect("the single-resource route is the same read as filter[id], first 1", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const url = "/jsonapi/products/p-01?include=variants";
        const { status, body } = yield* world.get(url);
        expect(status).toBe(200);
        expect(body.data.id).toBe("p-01");
        expect(body.included.map((v: Json) => v.id)).toEqual(["v-01a", "v-01b"]);
        expect(body.links.self).toBe("/jsonapi/products?include=variants&filter[id]=p-01&page[limit]=1");
        expect({ url, status, body }).toEqual(fixture("get-product-p-01", { url, status, body }));
        // The single-row route takes the graph's `fields[…]` too.
        const sparse = yield* world.get("/jsonapi/products/p-01?fields[products]=name");
        expect(sparse.status).toBe(200);
        expect(Object.keys(sparse.body.data.attributes)).toEqual(["name"]);
        const missing = yield* world.get("/jsonapi/products/p-99");
        expect(missing.status).toBe(404);
        expect(missing.body.errors[0]).toMatchObject({ status: "404", code: "not_found" });
      })
    )
  );

  it("spells the loads' URLs in the grammar (the README's examples)", () => {
    const url = (read: Query.Read) => JsonApiQuery.canonical(nodes, read);
    expect(url(productPage({ categoryId: "c-audio" }))).toBe(
      "/products?filter[categoryId]=c-audio&sort=id&page[limit]=4"
    );
    // The canonical string percent-encodes the include list's comma.
    expect(url(productDetail("p-01"))).toBe("/products?include=seller%2Cvariants&filter[id]=p-01");
    expect(url(productReviews("p-01"))).toBe("/reviews?filter[productId]=p-01&sort=-createdAt");
    expect(url(myCartItems("u1"))).toBe("/cartItems?include=variant&filter[userId]=u1");
    expect(url(myOrders("u1"))).toBe("/orders?filter[userId]=u1&sort=-createdAt");
    expect(url(allCategories)).toBe("/categories?sort=name");
  });
});

// ─── 2. The declarations agree ───────────────────────────────────────────────

/** What a node declares, as the bridge and the hand-written graph must both say it. */
const declarationOf = (node: Node.AnyNode) => ({
  attributes: Object.keys(node.attributes).toSorted(),
  edges: node.edges,
  filterable: node.filterable,
  sortable: [...node.sortable].toSorted(),
  hintKeys: node.hintKeys,
});

describe("src/lib/resources.ts agrees with src/lib/domain.ts", () => {
  it("bridges to the hand-written node graph, declaration for declaration", () => {
    // Hint keys are ADR-0023 fan-out state, not part of a JSON:API resource:
    // the one thing the bridge is told beside the resources.
    const hintKeys = { hintKeys: ["userId"] };
    const bridged = NodeBridge.registry([...resources], {
      reviews: hintKeys,
      cartItems: hintKeys,
      orders: hintKeys,
      orderItems: hintKeys,
    });
    expect([...bridged.nodes.keys()].toSorted()).toEqual(
      [...nodes.nodes.keys()].filter((type) => type !== "profiles").toSorted()
    );
    for (const [type, node] of bridged.nodes) {
      expect(declarationOf(node), type).toEqual(declarationOf(nodes.nodes.get(type)!));
    }
  });

  it("declares the usage table of #148: eq/in on the key fields, eq on userId, sortable name and createdAt", () => {
    const products = nodes.nodes.get("products")!;
    expect(products.filterable).toEqual({
      id: { kind: "text", operators: ["eq", "in"] },
      categoryId: { kind: "text", operators: ["eq", "in"] },
      sellerId: { kind: "text", operators: ["eq", "in"] },
    });
    expect(nodes.nodes.get("reviews")!.filterable["productId"]).toEqual({
      kind: "text",
      operators: ["eq", "in"],
    });
    expect(nodes.nodes.get("orders")!.filterable["userId"]).toEqual({
      kind: "text",
      operators: ["eq"],
    });
    expect(nodes.nodes.get("categories")!.sortable).toEqual(["id", "name"]);
    expect(nodes.nodes.get("orders")!.sortable).toEqual(["id", "createdAt"]);
  });
});

// ─── 3. The tier's promises ──────────────────────────────────────────────────

describe("the derived reads over the commerce server", () => {
  it.effect("scopes private collections by the auth policy: anonymous is empty, a filter only narrows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        for (const path of ["/jsonapi/cartItems", "/jsonapi/orders", "/jsonapi/orderItems"]) {
          const { status, body } = yield* world.get(path);
          expect(status).toBe(200);
          expect(body.data).toEqual([]);
        }
        // Without a filter, the policy alone scopes: u1 sees u1's rows.
        const mine = yield* world.get("/jsonapi/orders?sort=-createdAt", "u1");
        expect(mine.body.data.map((o: Json) => o.id)).toEqual(["o-2", "o-1"]);
        // A filter for another user's rows only narrows what the policy allows.
        const theirs = yield* world.get("/jsonapi/orders?filter[userId]=u2", "u1");
        expect(theirs.body.data).toEqual([]);
        // `userId` is served: the sync tier ships it, the resource declares it.
        expect(mine.body.data[0].attributes.userId).toBe("u1");
      })
    )
  );

  it.effect("fields[products]=name returns only name while linkage rides on the full row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { status, body } = yield* world.get("/jsonapi/products?fields[products]=name&sort=id");
        expect(status).toBe(200);
        expect(body.data).toHaveLength(6);
        for (const product of body.data) {
          expect(Object.keys(product.attributes)).toEqual(["name"]);
          expect(product.relationships.category.data.type).toBe("categories");
          expect(product.relationships.variants.data.length).toBeGreaterThan(0);
        }
        expect(body.links.self).toBe("/jsonapi/products?fields[products]=name&sort=id");
      })
    )
  );

  it.effect("a URL the grammar rejects is a 400 error document with source.parameter, before any backend call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const rejected: ReadonlyArray<readonly [string, string]> = [
          // The issue's hand-crafted request: `priceCents` is not in the filterable set.
          ["/jsonapi/products?filter[priceCents][gt]=abc", "filter[priceCents][gt]"],
          ["/jsonapi/products?filter[description]=oak", "filter[description]"],
          // `categoryId` is `eq` / `in` only.
          ["/jsonapi/products?filter[categoryId][gt]=c", "filter[categoryId][gt]"],
          // Only `id` sorts products; `name` sorts categories.
          ["/jsonapi/products?sort=name", "sort"],
          // Reviews are read as their own collection, not as a product edge.
          ["/jsonapi/products?include=reviews", "include"],
          // A single-resource request takes `include` and `fields[…]` only.
          ["/jsonapi/products/p-01?sort=id", "sort"],
        ];
        for (const [path, parameter] of rejected) {
          const before = world.calls();
          const { status, body } = yield* world.get(path);
          expect(status, path).toBe(400);
          expect(body.errors[0], path).toMatchObject({
            status: "400",
            source: { parameter },
          });
          expect(world.calls(), path).toBe(before);
        }
      })
    )
  );

  it.effect("pages by Subset.apply's cursor window: links.next continues after the last id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* world.get(`/jsonapi${JsonApiQuery.canonical(nodes, productPage({}))}`);
        expect(first.body.data.map((p: Json) => p.id)).toEqual(["p-01", "p-02", "p-03", "p-04"]);
        expect(first.body.links.next).toBe("/jsonapi/products?sort=id&page[limit]=4&page[after]=p-04");
        expect(first.body.links.next).toBe(
          `/jsonapi${JsonApiQuery.canonical(nodes, productPage({ cursor: "p-04" }))}`
        );
        const second = yield* world.get(first.body.links.next);
        expect(second.body.data.map((p: Json) => p.id)).toEqual(["p-05", "p-06"]);
        expect(second.body.links.next).toBeUndefined();
      })
    )
  );

  it.effect("a variant's product and a review's reviewer are linkage and attribute, as the graph declares them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const variants = yield* world.get("/jsonapi/variants?filter[productId]=p-01");
        expect(variants.body.data.map((v: Json) => v.id)).toEqual(["v-01a", "v-01b"]);
        expect(variants.body.data[0].attributes.productId).toBeUndefined();
        expect(variants.body.data[0].relationships.product).toEqual({
          data: { type: "products", id: "p-01" },
        });
        const reviews = yield* world.get(
          `/jsonapi${JsonApiQuery.canonical(nodes, productReviews("p-01"))}`
        );
        expect(reviews.body.data.map((r: Json) => [r.id, r.attributes.userId])).toEqual([
          ["r-04", "u2"],
          ["r-01", "seed-user"],
        ]);
      })
    )
  );
});
