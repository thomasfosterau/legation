/**
 * DocumentWriter tests (#163): rows → compound documents as a pure function
 * of (graph, read, rows, fields) — linkage from `via` keys and edge rows,
 * `included` deduplicated with full linkage checked, `fields[]` as a
 * projection applied after linkage, `links.self` canonical and `links.next`
 * from the cursor window.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Edge, Node, Predicate, type Query } from "@legation/effect";
import type { Related } from "@legation/effect/internal";
import * as DocumentWriter from "../DocumentWriter.js";
import * as JsonApiQuery from "../JsonApiQuery.js";

// ─── A commerce-shaped graph ─────────────────────────────────────────────────

const categories = Node.make("categories", { attributes: { name: Schema.String } });
const products = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  sortable: ["name"],
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    variants: Edge.many("variants", { inverse: "product" }),
    reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }),
  },
});
const variants = Node.make("variants", {
  attributes: { sku: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const reviews = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const nodes = Node.registry([categories, products, variants, reviews]);

const audio = { id: "c-audio", name: "Audio" };
const desk = { id: "p-1", categoryId: "c-audio", name: "Desk", priceCents: 100 };
const lamp = { id: "p-2", categoryId: "c-audio", name: "Lamp", priceCents: 200 };
const v1 = { id: "v-1", productId: "p-1", sku: "DSK-1" };
const v2 = { id: "v-2", productId: "p-1", sku: "DSK-2" };
const r1 = { id: "r-1", productId: "p-1", body: "Solid", createdAt: "2026-02-01T00:00:00.000Z" };

const row = (
  value: { readonly id: string; readonly [field: string]: unknown },
  related: Related.RelatedRow["related"] = {}
): Related.RelatedRow => ({
  id: value.id,
  value,
  related,
});

describe("DocumentWriter.collection", () => {
  it("writes attributes from the node, linkage from via keys and edge rows, links canonical", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products", order: ["name"] },
      rows: [row(desk, { variants: [v1, v2] }), row(lamp, { variants: [] })],
    });
    expect(document).toEqual({
      data: [
        {
          type: "products",
          id: "p-1",
          attributes: { name: "Desk", priceCents: 100 },
          relationships: {
            category: { data: { type: "categories", id: "c-audio" } },
            variants: {
              data: [
                { type: "variants", id: "v-1" },
                { type: "variants", id: "v-2" },
              ],
            },
            reviews: {
              links: {
                self: "/products/p-1/relationships/reviews",
                related: "/products/p-1/reviews",
              },
            },
          },
        },
        {
          type: "products",
          id: "p-2",
          attributes: { name: "Lamp", priceCents: 200 },
          relationships: {
            category: { data: { type: "categories", id: "c-audio" } },
            variants: { data: [] },
            reviews: {
              links: {
                self: "/products/p-2/relationships/reviews",
                related: "/products/p-2/reviews",
              },
            },
          },
        },
      ],
      links: { self: "/products?sort=name" },
    });
  });

  it("omits a many edge nothing was resolved for, and relationships on an edgeless node", () => {
    const partial = DocumentWriter.collection({
      nodes,
      read: { collection: "products" },
      rows: [row(desk)],
    });
    expect(Object.keys(partial.data[0]!.relationships!)).toEqual(["category", "reviews"]);
    const plain = DocumentWriter.collection({
      nodes,
      read: { collection: "categories" },
      rows: [row(audio)],
    });
    expect(plain.data[0]).toEqual({
      type: "categories",
      id: "c-audio",
      attributes: { name: "Audio" },
    });
    expect(plain.data[0]).not.toHaveProperty("relationships");
  });

  it("compounds the included edges in edge-name then row order, deduplicated by (type, id)", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products", include: { variants: true, category: true } },
      rows: [
        row(desk, { variants: [v1, v2], category: audio }),
        row(lamp, { variants: [], category: audio }),
      ],
    });
    expect(document.included?.map((resource) => `${resource.type}/${resource.id}`)).toEqual([
      "categories/c-audio",
      "variants/v-1",
      "variants/v-2",
    ]);
    // An included resource carries its own one-edge linkage.
    expect(document.included?.[1]).toEqual({
      type: "variants",
      id: "v-1",
      attributes: { sku: "DSK-1" },
      relationships: { product: { data: { type: "products", id: "p-1" } } },
    });
    expect(document.links).toEqual({ self: "/products?include=category%2Cvariants" });
  });

  it("gives a paginated edge its links, and its rows' linkage beside them when resolved", () => {
    const links = { self: "/products/p-1/relationships/reviews", related: "/products/p-1/reviews" };
    const unresolved = DocumentWriter.collection({
      nodes,
      read: { collection: "products" },
      rows: [row(desk)],
    });
    expect(unresolved.data[0]!.relationships!["reviews"]).toEqual({ links });
    const included = DocumentWriter.collection({
      nodes,
      read: { collection: "products", include: { reviews: true } },
      rows: [row(desk, { reviews: [r1] })],
    });
    expect(included.data[0]!.relationships!["reviews"]).toEqual({
      links,
      data: [{ type: "reviews", id: "r-1" }],
    });
    expect(included.included?.map((resource) => resource.id)).toEqual(["r-1"]);
    expect(included.links).toEqual({ self: "/products?include=reviews" });
  });

  it("projects fields[type] over attributes only, after linkage, on primary and included alike", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products", include: { variants: true } },
      rows: [row(desk, { variants: [v1] })],
      fields: { products: ["name"], variants: [] },
    });
    expect(document.data[0]!.attributes).toEqual({ name: "Desk" });
    expect(document.data[0]!.relationships!["category"]).toEqual({
      data: { type: "categories", id: "c-audio" },
    });
    expect(document.included?.[0]!.attributes).toEqual({});
    expect(document.links).toEqual({
      self: "/products?include=variants&fields[products]=name&fields[variants]=",
    });
  });

  it("fields[products]=name&include=variants: only name, full linkage to every included variant", () => {
    const { read, fields } = Effect.runSync(
      JsonApiQuery.parseRead(nodes, "/products?fields[products]=name&include=variants")
    );
    const document = DocumentWriter.collection({
      nodes,
      read,
      rows: [row(desk, { variants: [v1, v2] }), row(lamp, { variants: [] })],
      ...(fields === undefined ? {} : { fields }),
    });
    expect(document.data.map((resource) => resource.attributes)).toEqual([
      { name: "Desk" },
      { name: "Lamp" },
    ]);
    // Every included variant is referenced by a primary resource's linkage,
    // and the included variants are full (no fields[variants]).
    const linked = new Set(
      document.data.flatMap((resource) => {
        const linkage = resource.relationships!["variants"]! as {
          data: ReadonlyArray<{ id: string }>;
        };
        return linkage.data.map((identifier) => identifier.id);
      })
    );
    expect(document.included!.map((resource) => resource.id)).toEqual(["v-1", "v-2"]);
    expect(document.included!.every((resource) => linked.has(resource.id))).toBe(true);
    expect(document.included![0]).toEqual({
      type: "variants",
      id: "v-1",
      attributes: { sku: "DSK-1" },
      relationships: { product: { data: { type: "products", id: "p-1" } } },
    });
    expect(document.links).toEqual({ self: "/products?include=variants&fields[products]=name" });
  });

  it("rejects a row set that violates full linkage instead of emitting it", () => {
    // The edge row is present, but the row's own key does not reference it:
    // the primary resource says `category: null`, so the included category
    // would be an unreferenced included resource (spec §compound documents).
    const orphaned = { ...desk, categoryId: null };
    expect(() =>
      DocumentWriter.collection({
        nodes,
        read: { collection: "products", include: { category: true } },
        rows: [row(orphaned, { category: audio })],
      })
    ).toThrow(/full linkage violation.*categories:c-audio/);
    expect(() =>
      DocumentWriter.data({
        nodes,
        read: {
          collection: "products",
          where: { id: "p-1" },
          include: { category: true },
          first: 1,
        },
        rows: [row(orphaned, { category: audio })],
      })
    ).toThrow(/full linkage violation/);
  });

  it("links next at the last row's id when the window is full, and not when the page is short", () => {
    const full = DocumentWriter.collection({
      nodes,
      read: { collection: "products", order: ["name"], first: 2 },
      rows: [row(desk), row(lamp)],
    });
    expect(full.links).toEqual({
      self: "/products?sort=name&page[limit]=2",
      next: "/products?sort=name&page[limit]=2&page[after]=p-2",
    });
    const short = DocumentWriter.collection({
      nodes,
      read: { collection: "products", order: ["name"], first: 2, after: "p-2" },
      rows: [row(lamp)],
    });
    expect(short.links).toEqual({ self: "/products?sort=name&page[limit]=2&page[after]=p-2" });
  });

  it("links.next round-trips through the parser to the read advanced past the last row", () => {
    const read: Query.Read = {
      collection: "products",
      where: { categoryId: "c-audio" },
      include: { variants: true },
      order: ["name"],
      first: 2,
    };
    const fields = { products: ["name"] };
    const page = DocumentWriter.collection({
      nodes,
      read,
      rows: [row(desk, { variants: [v1] }), row(lamp, { variants: [] })],
      fields,
      prefix: "/api",
    });
    const next = Effect.runSync(JsonApiQuery.parseRead(nodes, page.links!.next as string));
    // The same read, `after` at the last row — as `Subset.apply` continues it —
    // with the projection still beside it; nothing else moved.
    expect(next).toEqual({
      read: { ...read, where: Predicate.eq("categoryId", "c-audio"), after: "p-2" },
      fields,
    });
    expect(JsonApiQuery.canonical(nodes, next.read, next.fields)).toBe(
      (page.links!.next as string).slice("/api".length)
    );
    // The advanced read's own document continues the chain from where it stood.
    const second = DocumentWriter.collection({ nodes, read: next.read, rows: [row(lamp)], fields });
    expect(second.links).toEqual({
      self: "/products?include=variants&fields[products]=name&filter[categoryId]=c-audio&sort=name&page[limit]=2&page[after]=p-2",
    });
  });

  it("prefixes every link with the api's mount path", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products", first: 1 },
      rows: [row(desk)],
      prefix: "/jsonapi",
    });
    expect(document.links).toEqual({
      self: "/jsonapi/products?page[limit]=1",
      next: "/jsonapi/products?page[limit]=1&page[after]=p-1",
    });
    expect(document.data[0]!.relationships!["reviews"]).toEqual({
      links: {
        self: "/jsonapi/products/p-1/relationships/reviews",
        related: "/jsonapi/products/p-1/reviews",
      },
    });
  });

  it("is a pure function of its inputs: the same rows written twice are equal byte for byte", () => {
    const input: DocumentWriter.Input = {
      nodes,
      read: { collection: "products", include: { variants: true }, first: 10 },
      rows: [row(desk, { variants: [v1] })],
      fields: { products: ["priceCents", "name"] },
    };
    expect(JSON.stringify(DocumentWriter.collection(input))).toBe(
      JSON.stringify(DocumentWriter.collection({ ...input }))
    );
  });
});

describe("DocumentWriter.data", () => {
  it("writes the first row as primary data with its includes, and null for no row", () => {
    const read: Query.Read = {
      collection: "products",
      where: { id: "p-1" },
      include: { variants: true },
      first: 1,
    };
    const found = DocumentWriter.data({ nodes, read, rows: [row(desk, { variants: [v1] })] });
    expect(found.data?.id).toBe("p-1");
    expect(found.included).toHaveLength(1);
    expect(found.links).toEqual({
      self: "/products?include=variants&filter[id]=p-1&page[limit]=1",
    });
    const missing = DocumentWriter.data({ nodes, read, rows: [] });
    expect(missing).toEqual({
      data: null,
      links: { self: "/products?include=variants&filter[id]=p-1&page[limit]=1" },
    });
  });
});

describe("DocumentWriter row shapes", () => {
  // The same rows in `Derive.ts`'s shape: attributes flattened, linkage under `relationships`.
  const jsonDesk = {
    id: "p-1",
    name: "Desk",
    priceCents: 100,
    relationships: {
      category: { type: "categories", id: "c-audio" },
      variants: [
        { type: "variants", id: "v-1" },
        { type: "variants", id: "v-2" },
      ],
    },
  };
  const jsonLamp = {
    id: "p-2",
    name: "Lamp",
    priceCents: 200,
    relationships: { category: null, variants: [] },
  };
  const jsonV1 = {
    id: "v-1",
    sku: "DSK-1",
    relationships: { product: { type: "products", id: "p-1" } },
  };

  it("writes JsonApiRows through the same writer: linkage off `relationships`, attributes as declared", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products", include: { variants: true } },
      rows: [row(jsonDesk, { variants: [jsonV1] }), row(jsonLamp, { variants: [] })],
      shape: DocumentWriter.jsonApiRows,
    });
    expect(document.data[0]).toEqual({
      type: "products",
      id: "p-1",
      attributes: { name: "Desk", priceCents: 100 },
      relationships: {
        category: { data: { type: "categories", id: "c-audio" } },
        // Resolved rows win over the row's own identifiers (one variant was resolved).
        variants: { data: [{ type: "variants", id: "v-1" }] },
        reviews: {
          links: { self: "/products/p-1/relationships/reviews", related: "/products/p-1/reviews" },
        },
      },
    });
    expect(document.data[1]!.relationships!["category"]).toEqual({ data: null });
    expect(document.included).toEqual([
      {
        type: "variants",
        id: "v-1",
        attributes: { sku: "DSK-1" },
        relationships: { product: { data: { type: "products", id: "p-1" } } },
      },
    ]);
  });

  it("links a many edge the read did not resolve through the identifiers the JsonApiRow carries", () => {
    const document = DocumentWriter.collection({
      nodes,
      read: { collection: "products" },
      rows: [row(jsonDesk), row({ id: "p-3", name: "Bare", priceCents: 1, relationships: {} })],
      shape: DocumentWriter.jsonApiRows,
    });
    expect(document.data[0]!.relationships!["variants"]).toEqual({
      data: [
        { type: "variants", id: "v-1" },
        { type: "variants", id: "v-2" },
      ],
    });
    // A row that carries no linkage for the edge omits it, as a node row does.
    expect(Object.keys(document.data[1]!.relationships!)).toEqual(["category", "reviews"]);
    expect(document.data[1]!.relationships!["category"]).toEqual({ data: null });
    // Node rows never carry collection-valued linkage of their own.
    const plain = DocumentWriter.collection({
      nodes,
      read: { collection: "products" },
      rows: [row(desk)],
    });
    expect(plain.data[0]!.relationships).not.toHaveProperty("variants");
  });
});
