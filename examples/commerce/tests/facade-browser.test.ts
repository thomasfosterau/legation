/**
 * The façade end to end, in a browser (ADR-0029, issue #168): the built
 * commerce app served with its service worker active (`tests/support/app.ts`),
 * driven with Playwright over the pre-installed Chromium, and plain
 * `fetch()`es of JSON:API URLs issued from the page's main thread — the
 * front no `Client` sees. The tab's shell pins (`shellReads`, registered
 * by `+layout.svelte`'s boot) are the subscriptions; the worker's façade
 * answers what they cover from the replica and forwards the rest.
 *
 * Four demonstrations, in order, on one page:
 *
 * 1. **Online, the network.** A category page — uncovered under the
 *    windowed products pin (ADR-0029 §3, the strict window) — reaches the
 *    derived handler on the real server: no `x-legation-served-at`, the
 *    backend asked, the document the server wrote. Once the engine has
 *    pulled, the first catalog page — a prefix of the pin — is served
 *    locally while online: the header carries the replica's cookie, the
 *    server is never asked, and the content is byte for byte the network's
 *    answer to the same URL (§6).
 * 2. **Offline, the replica.** With the network disabled the same covered
 *    URL is answered identically, header present.
 * 3. **Offline, uncovered.** The category page is the 503 `offline` error
 *    document (§4): JSON:API media type, `code: "offline"`, the cookie
 *    header on it — under each half of §4's definition in turn: the
 *    browser reading offline (nothing is forwarded, the server is never
 *    asked), and the browser reading online while the forward rejects at
 *    the transport (the harness drops the worker's connection). The
 *    covered URL is unaffected either way.
 * 4. **Offline, a pending write.** On the product page (served offline
 *    from the worker's page cache, visited once online in 1) "Add to
 *    cart" journals `cart/add`; the covered cart URL shows the pending
 *    line under the optimistic overlay while the server's table has none
 *    (§4, "the optimistic overlay"), with the sync carriers down for the
 *    offline window; back online the carriers return, the journal pushes
 *    and the server catches up.
 *
 * Each demonstration sets the connectivity it needs at its start, so a
 * failure in one cannot leave the next in the wrong state.
 *
 * Offline is `context.setOffline(true)` rather than a raw CDP session per
 * target: Playwright applies the `Network.emulateNetworkConditions`
 * emulation to every page and every attached service worker of the context
 * in one call, and it is what a Chromium user sees under DevTools'
 * offline toggle — the page's fetches fail, and `navigator.onLine` reads
 * false in the page and in the worker. That is the browser's offline
 * signal, not the transport's: the worker's engine never hears the
 * `online`/`offline` events (#328), and its sync WebSocket stays open
 * under the emulation, so a push goes out over it whatever
 * `navigator.onLine` says. The transport half of §4 is therefore exercised
 * by the harness instead: `app.blackout` drops the app's own requests (the
 * browser stays "online"), and `app.carriers` cuts the sync carriers —
 * demonstration 4 cuts them for its offline window, so its pending write
 * cannot reach the server by any path.
 *
 * Identity is the app's own: the test signs up through the account page's
 * form (Better Auth), the Kit process aligns the client-group binding, and
 * the read proxy vouches for the session — the browser never sets
 * `x-commerce-user`. The network's reference documents come from
 * `context.request`, which shares the context's cookies but not its
 * service worker.
 *
 * Chromium missing is a failure with the path named, never a skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi";
import { myCartItems, productPage } from "../src/lib/domain.js";
import { readPath } from "../src/lib/reads.js";
import { serveApp, type App } from "./support/app.js";

type Json = any;

/** What a page-side `fetch` of a JSON:API URL came back with. */
interface Fetched {
  readonly status: number;
  readonly servedAt: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

/** A plain `fetch` from the page's main thread — the front the façade intercepts. */
const fetched = (page: Page, path: string): Promise<Fetched> =>
  page.evaluate(async (path: string) => {
    const response = await fetch(path, { headers: { accept: "application/vnd.api+json" } });
    return {
      status: response.status,
      servedAt: response.headers.get("x-legation-served-at"),
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }, path);

/** The network's answer, outside the service worker, with the context's cookies. */
const fromNetwork = async (context: BrowserContext, origin: string, path: string) => {
  const response = await context.request.get(`${origin}${path}`, {
    headers: { accept: MEDIA_TYPE },
  });
  return { status: response.status(), body: await response.text() };
};

/** Document content, whitespace aside (ADR-0029 §6 binds content, not framing). */
const content = (body: string): string => JSON.stringify(JSON.parse(body));

/** Poll until `predicate` holds for `probe`'s result; the last result on timeout. */
const until = async <A>(
  probe: () => Promise<A>,
  predicate: (value: A) => boolean,
  options: { readonly timeout: number; readonly interval?: number }
): Promise<A> => {
  const deadline = Date.now() + options.timeout;
  let last = await probe();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.interval ?? 250));
    last = await probe();
  }
  return last;
};

const served = (result: Fetched) => result.servedAt !== null && result.servedAt !== "";

const USER = { name: "Ada", email: "ada@example.test", password: "correct horse battery" };

const firstPage = readPath(productPage({}));
const keyboardsPage = readPath(productPage({ categoryId: "c-keyboards" }));

let app: App;
let browser: Browser;
let context: BrowserContext;
let page: Page;
/** The signed-up user's id (Better Auth's), once known. */
let userId: string;
/** The network's document for the first catalog page, from demonstration 1. */
let firstPageFromNetwork: string;

describe("the façade in a browser: plain fetch over the service worker's replica (#168)", () => {
  beforeAll(async () => {
    const executablePath = chromium.executablePath();
    if (!existsSync(executablePath)) {
      throw new Error(
        `Chromium is not installed at ${executablePath}. Install it with ` +
          "`bunx playwright-core install chromium` (or point PLAYWRIGHT_BROWSERS_PATH at " +
          "an existing Playwright browser directory). This test fails rather than skips."
      );
    }
    app = await serveApp();
    browser = await chromium.launch({ executablePath });
    context = await browser.newContext();
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await app?.close();
    }
  }, 30_000);

  it("boots: signs up, the worker controls the page, the engine serves the shell's pins", async () => {
    await page.goto(`${app.origin}/account`);
    const signup = page.locator('form[action="?/signup"]');
    await signup.locator('input[name="name"]').fill(USER.name);
    await signup.locator('input[name="email"]').fill(USER.email);
    await signup.locator('input[name="password"]').fill(USER.password);
    await Promise.all([page.waitForURL(`${app.origin}/`), signup.locator("button").click()]);
    await expect.poll(() => page.locator("nav").textContent()).toContain(`signed in as ${USER.name}`);
    const users = await Effect.runPromise(
      app.sql<{ id: string }>`SELECT id FROM user WHERE email = ${USER.email}`
    );
    userId = users[0]!.id;

    // The worker: registered by Kit, `clients.claim()`ed on activation, so
    // the page is controlled without a reload — reload once if not.
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (await page.evaluate(() => navigator.serviceWorker.controller === null)) {
      await page.reload();
      await page.evaluate(() => navigator.serviceWorker.ready);
    }
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  }, 30_000);

  it("1. online: an uncovered URL is the network's; a covered one, once pulled, is the replica's — same bytes", async () => {
    // The category page: rule 2's strict window sends it to the server.
    const before = app.restCalls();
    const keyboards = await fetched(page, keyboardsPage);
    expect(keyboards.status).toBe(200);
    expect(keyboards.servedAt).toBeNull();
    expect(app.restCalls()).toBeGreaterThan(before);
    const reference = await fromNetwork(context, app.origin, keyboardsPage);
    expect(content(keyboards.body)).toBe(content(reference.body));
    expect((JSON.parse(keyboards.body) as Json).data.map((p: Json) => p.id)).toEqual(["p-03", "p-04"]);

    // The first page: the engine boots on the tab's handshake and pins the
    // shell; a pin's rows land on a later pull (a poke, or the 15-second
    // backstop). Until a pull has landed for every registration the page
    // needs, the façade forwards the request (ADR-0029 section 3, #426), so
    // the network answers; the wait ends on a served answer whose body is
    // the network's, byte for byte.
    firstPageFromNetwork = (await fromNetwork(context, app.origin, firstPage)).body;
    const local = await until(
      () => fetched(page, firstPage),
      (result) => served(result) && content(result.body) === content(firstPageFromNetwork),
      { timeout: 40_000 }
    );
    expect(local.status).toBe(200);
    expect(served(local), "x-legation-served-at carries the replica's cookie").toBe(true);
    expect(local.contentType).toBe(MEDIA_TYPE);
    expect(content(local.body)).toBe(content(firstPageFromNetwork));
    // Served locally: the server is not asked.
    const calls = app.restCalls();
    const again = await fetched(page, firstPage);
    expect(served(again)).toBe(true);
    expect(app.restCalls()).toBe(calls);

    // Visit the product page once online so the worker's page cache holds
    // it: demonstration 4 navigates there offline, and must not depend on
    // how the browser's offline emulation treats the worker's own fetches.
    await page.goto(`${app.origin}/product/p-01`);
    await expect.poll(() => page.locator("h1").textContent()).toContain("Studio Headphones");
  }, 60_000);

  it("2. offline: the covered URL is served from the replica, header present, same bytes", async () => {
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const local = await fetched(page, firstPage);
    expect(local.status).toBe(200);
    expect(served(local)).toBe(true);
    expect(content(local.body)).toBe(content(firstPageFromNetwork));
  }, 15_000);

  it("3. offline: an uncovered URL is the 503 `offline` error document, by either half of §4", async () => {
    const isOfflineDocument = (result: Fetched) => {
      expect(result.status).toBe(503);
      expect(result.contentType).toBe(MEDIA_TYPE);
      expect(result.servedAt).not.toBeNull();
      const document = JSON.parse(result.body) as Json;
      expect(document.errors).toHaveLength(1);
      expect(document.errors[0]).toMatchObject({ status: "503", code: "offline" });
    };
    // The browser reads offline: the worker's `navigator.onLine` is false,
    // so nothing is forwarded and the server is never asked.
    await context.setOffline(true);
    const calls = app.restCalls();
    isOfflineDocument(await fetched(page, keyboardsPage));
    expect(app.restCalls()).toBe(calls);

    // The browser reads online, but the forward rejects at the transport:
    // the worker's `fetch` of the unchanged request fails, and the worker
    // answers with `facade.offline` (src/service-worker.ts).
    await context.setOffline(false);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    app.blackout(true);
    try {
      isOfflineDocument(await fetched(page, keyboardsPage));
      // A covered request is never affected by connectivity.
      const local = await fetched(page, firstPage);
      expect(local.status).toBe(200);
      expect(served(local)).toBe(true);
    } finally {
      app.blackout(false);
    }
  }, 20_000);

  it("4. offline: a pending optimistic cart write is visible in the covered cart response", async () => {
    // The carriers go down before the browser goes offline: the worker's
    // engine keeps its WebSocket under the emulation and would push its
    // optimistic write at the push debounce (300 ms after the journal
    // write), so the write is kept off the server by the cut, not by the
    // timing of the read below.
    app.carriers(false);
    await context.setOffline(true);
    const cartPath = readPath(myCartItems(userId));
    // The cart is empty on both sides, and the cart URL is covered (the
    // shell pins `myCartItems` for a signed-in user).
    const empty = await fetched(page, cartPath);
    expect(served(empty)).toBe(true);
    expect((JSON.parse(empty.body) as Json).data).toEqual([]);

    // Add to cart offline: the product page comes from the worker's page
    // cache (visited online in demonstration 1); `cart/add` journals in
    // the worker's engine and renders in the optimistic overlay; with the
    // carriers down the push cannot reach the server.
    const navigation = await page.goto(`${app.origin}/product/p-01`);
    expect(navigation?.fromServiceWorker()).toBe(true);
    await page.locator("button", { hasText: "Add to cart" }).first().click();
    const pending = await until(
      () => fetched(page, cartPath),
      // A transient 503 offline document has no `data`: the predicate polls through it.
      (result) =>
        result.status === 200 &&
        served(result) &&
        (JSON.parse(result.body) as Json).data?.length === 1,
      { timeout: 10_000 }
    );
    expect(served(pending)).toBe(true);
    const line = (JSON.parse(pending.body) as Json).data[0];
    expect(line.type).toBe("cartItems");
    expect(line.attributes).toMatchObject({ userId, qty: 1 });
    expect(line.relationships.variant.data).toEqual({ type: "variants", id: "v-01a" });
    // The overlay, not the server: the authoritative table has no line yet.
    const rows = await Effect.runPromise(
      app.sql<{ n: number }>`SELECT COUNT(*) AS n FROM cartItems WHERE userId = ${userId}`
    );
    expect(rows[0]!.n).toBe(0);

    // Back online the carriers come back, the journal pushes and the server
    // catches up.
    app.carriers(true);
    await context.setOffline(false);
    const converged = await until(
      () =>
        Effect.runPromise(
          app.sql<{ id: string }>`SELECT id FROM cartItems WHERE userId = ${userId}`
        ),
      (result) => result.length === 1,
      { timeout: 20_000 }
    );
    expect(converged.map((row) => row.id)).toEqual([line.id]);
  }, 45_000);
});
