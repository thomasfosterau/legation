/**
 * The no-JS baseline (README): with JavaScript disabled the pages render
 * from their SvelteKit loads alone, and the loads read the JSON:API at the
 * canonical URLs of the app's declarative reads. This runs the real `load`
 * functions of `src/routes/**\/+page.server.ts` — and the catalog's
 * universal `+page.ts` (#168), which the server runs for the first render
 * exactly as it runs a server load — against the commerce server
 * in-process: `fetch`, global and the load event's alike, is pointed at
 * the api's web handler, so `SYNC_ORIGIN` is never dialled. It checks the
 * data each page renders without a client: the catalog filtered by
 * category, the product detail with its variants and seller, the reviews
 * newest first, the cart lines with their variants, the orders newest
 * first — and that the read proxy the universal load calls
 * (`src/routes/jsonapi/[...path]/+server.ts`) vouches for the session and
 * for nothing else. Rendering the Svelte markup itself needs the Kit
 * runtime and stays a manual check (`pnpm run dev`, JavaScript off).
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { isHttpError } from "@sveltejs/kit";
import { makeWorld, type World } from "./support/world.js";

let world: World;
let scope: Scope.Closeable;
const realFetch = globalThis.fetch;

/** Every URL handed to {@link apiFetch}, in order — what the read proxy sent upstream. */
const forwarded: Array<string> = [];

/** The api's handler as a `fetch`: a relative URL is the app's own origin. */
const apiFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(
    input instanceof Request ? input : new URL(input, "http://app.test"),
    init
  );
  forwarded.push(request.url);
  return world.handler(request);
}) as typeof fetch;

beforeAll(async () => {
  scope = Effect.runSync(Scope.make());
  world = await Effect.runPromise(makeWorld.pipe(Scope.provide(scope)));
  // The server loads' `FetchHttpClient`, and the read proxy, read
  // `globalThis.fetch` per request.
  globalThis.fetch = apiFetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

/**
 * A load's event: the server loads read `locals`, `url` and `params`; the
 * universal catalog load reads `url` and its `fetch`, which on the server
 * calls the read proxy in-process — here, the api's handler directly.
 */
const event = (input: {
  readonly user?: { readonly id: string; readonly name: string; readonly email: string };
  readonly url?: string;
  readonly params?: Record<string, string>;
}) =>
  ({
    locals: { user: input.user },
    url: new URL(input.url ?? "http://app.test/"),
    params: input.params ?? {},
    fetch: apiFetch,
  }) as never;

const u1 = { id: "u1", name: "Ada", email: "ada@example.test" };

describe("the SvelteKit loads (the no-JS baseline) over the derived JSON:API", () => {
  it("catalog: the first page by id, every category by name, every variant for the stock badges", async () => {
    const { load } = await import("../src/routes/+page.js");
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
    const { load } = await import("../src/routes/+page.js");
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
    const { load } = await import("../src/routes/+page.js");
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

  it("the read proxy: forwards a URL as the session user, never as the header the client sent", async () => {
    const { GET } = await import("../src/routes/jsonapi/[...path]/+server.js");
    const cart = "/jsonapi/cartItems?filter[userId]=u1&include=variant";
    const proxied = (user: typeof u1 | undefined, path: string) =>
      GET({
        params: { path: path.slice("/jsonapi/".length, path.indexOf("?")) },
        url: new URL(`http://app.test${path}`),
        request: new Request(`http://app.test${path}`, {
          // A client asserting an identity: dropped, not forwarded.
          headers: { accept: "application/vnd.api+json", "x-commerce-user": "u1" },
        }),
        locals: { user },
      } as never);
    const mine = await proxied(u1, cart);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("application/vnd.api+json");
    const document = (await mine.json()) as { data: ReadonlyArray<{ id: string }> };
    expect(document.data.map((line) => line.id)).toEqual(["ci-1", "ci-2"]);
    // Signed out, the same URL is the policy's empty allow-set: nothing.
    const anonymous = (await (await proxied(undefined, cart)).json()) as {
      data: ReadonlyArray<unknown>;
    };
    expect(anonymous.data).toEqual([]);
    // The server's verdict on a URL outside the grammar passes through as is.
    const rejected = await proxied(u1, "/jsonapi/products?filter[priceCents][gt]=abc");
    expect(rejected.status).toBe(400);
    // The URL goes upstream as spelt — the raw path, never the decoded
    // route param — so a percent-encoded `#` in an id keeps its query and
    // reaches the server as that id (which it rules on: no such product).
    const encoded = await proxied(u1, "/jsonapi/products/p%2301?include=variants");
    expect(forwarded.at(-1)).toBe("http://localhost:3100/jsonapi/products/p%2301?include=variants");
    expect(encoded.status).toBe(404);
  });
});
