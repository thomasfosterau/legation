/**
 * The no-JS baseline (README): with JavaScript disabled the pages render
 * from their SvelteKit server loads alone, and the loads read the JSON:API
 * at the canonical URLs of the app's declarative reads. This runs the real
 * `load` functions of `src/routes/**\/+page.server.ts` against the commerce
 * server in-process — `fetch` is pointed at the api's web handler, so
 * `SYNC_ORIGIN` is never dialled — and checks the data each page renders
 * without a client: the catalog filtered by category, the product detail
 * with its variants and seller, the reviews newest first, the cart lines
 * with their variants, the orders newest first. Rendering the Svelte markup
 * itself needs the Kit runtime and stays a manual check (`bun run dev`,
 * JavaScript off).
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { isHttpError } from "@sveltejs/kit";
import { makeWorld, type World } from "./support/world.js";

let world: World;
let scope: Scope.Closeable;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  scope = Effect.runSync(Scope.make());
  world = await Effect.runPromise(makeWorld.pipe(Scope.provide(scope)));
  // The loads' `FetchHttpClient` reads `globalThis.fetch` per request.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    world.handler(new Request(input, init))) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** A load's event: the loads read `locals`, `url` and `params` only. */
const event = (input: {
  readonly user?: { readonly id: string; readonly name: string; readonly email: string };
  readonly url?: string;
  readonly params?: Record<string, string>;
}) =>
  ({
    locals: { user: input.user },
    url: new URL(input.url ?? "http://app.test/"),
    params: input.params ?? {},
  }) as never;

const u1 = { id: "u1", name: "Ada", email: "ada@example.test" };

describe("the SvelteKit loads (the no-JS baseline) over the derived JSON:API", () => {
  it("catalog: the first page by id, every category by name, every variant for the stock badges", async () => {
    const { load } = await import("../src/routes/+page.server.js");
    const data = await load(event({}));
    expect(data.categoryId).toBeUndefined();
    expect(data.after).toBeUndefined();
    expect(data.products.map((p) => p.id)).toEqual(["p-01", "p-02", "p-03", "p-04"]);
    // The page's "Next page" link: the document said there is more, from the last row.
    expect(data.nextCursor).toBe("p-04");
    expect(data.categories.map((c) => c.attributes.name)).toEqual(["Audio", "Desks", "Keyboards"]);
    expect(data.variants).toHaveLength(9);
    // A variant's product is linkage — what the stock aggregate groups by.
    expect(data.variants[0]?.relationships?.product.data).toEqual({ type: "products", id: "p-01" });
  });

  it("catalog filtered by category: `?category=` is filter[categoryId] on the same read", async () => {
    const { load } = await import("../src/routes/+page.server.js");
    const data = await load(event({ url: "http://app.test/?category=c-keyboards" }));
    expect(data.categoryId).toBe("c-keyboards");
    expect(data.products.map((p) => p.id)).toEqual(["p-03", "p-04"]);
    for (const product of data.products) {
      expect(product.relationships?.category.data.id).toBe("c-keyboards");
    }
    // Two keyboards fill no window: no next page.
    expect(data.nextCursor).toBeUndefined();
  });

  it("catalog paged by `?after=`: the second page is the same read one window on, and the last", async () => {
    const { load } = await import("../src/routes/+page.server.js");
    const first = await load(event({}));
    const second = await load(event({ url: `http://app.test/?after=${first.nextCursor}` }));
    expect(second.after).toBe("p-04");
    expect(second.products.map((p) => p.id)).toEqual(["p-05", "p-06"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("product detail: the product with its variants and seller, and its reviews newest first", async () => {
    const { load } = await import("../src/routes/product/[id]/+page.server.js");
    const data = await load(event({ params: { id: "p-01" } }));
    expect(data.product.id).toBe("p-01");
    expect(data.product.attributes.name).toBe("Studio Headphones");
    expect(data.variants.map((v) => v.id)).toEqual(["v-01a", "v-01b"]);
    expect(data.seller?.attributes.name).toBe("Acme Peripherals");
    expect(data.reviews.map((r) => r.id)).toEqual(["r-04", "r-01"]);
  });

  it("product detail: a product the read does not match is the page's 404", async () => {
    const { load } = await import("../src/routes/product/[id]/+page.server.js");
    const failure = await load(event({ params: { id: "p-99" } })).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(isHttpError(failure, 404)).toBe(true);
  });

  it("cart: the signed-in user's lines with their variants; nothing when signed out", async () => {
    const { load } = await import("../src/routes/cart/+page.server.js");
    const mine = await load(event({ user: u1 }));
    expect(mine.lines.map((line) => line.id)).toEqual(["ci-1", "ci-2"]);
    expect(mine.lines.map((line) => line.relationships?.variant.data.id)).toEqual(["v-01a", "v-03a"]);
    expect(mine.variants.map((v) => v.id).toSorted()).toEqual(["v-01a", "v-03a"]);
    const anonymous = await load(event({}));
    expect(anonymous).toEqual({ lines: [], variants: [] });
  });

  it("orders: the signed-in user's orders newest first; nothing when signed out", async () => {
    const { load } = await import("../src/routes/orders/+page.server.js");
    const mine = await load(event({ user: u1 }));
    expect(mine.orders.map((o) => [o.id, o.attributes.status])).toEqual([
      ["o-2", "shipped"],
      ["o-1", "placed"],
    ]);
    const someoneElse = await load(event({ user: { ...u1, id: "u3" } }));
    expect(someoneElse.orders).toEqual([]);
    expect(await load(event({}))).toEqual({ orders: [] });
  });
});
