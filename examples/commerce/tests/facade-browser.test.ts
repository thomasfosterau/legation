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
 * signal, not the transport's. The worker has no `online`/`offline` events,
 * so its engine learns of the flip by probing `navigator.onLine` (#328), but
 * auto-push does not consult that status, and the worker's sync WebSocket
 * stays open under the emulation, so a push goes out over it whatever
 * `navigator.onLine` says. The transport half of §4 is therefore exercised
 * by the harness instead: `app.blackout` drops the app's own requests (the
 * browser stays "online"), and `app.carriers` cuts the sync carriers —
 * demonstration 4 cuts them for its offline window, so its pending write
 * cannot reach the server by any write path.
 *
 * The waits are on the worker's signals, not on the clock. The worker relays
 * each completed pull (`legation:pull-landed`), journaled write
 * (`legation:mutation-journaled`) and acknowledged push
 * (`legation:push-completed`) to its tabs (`PageSignal`, `src/lib/host.ts`),
 * and `signals` records them here through a page binding. A wait starts from
 * a mark taken before the step it awaits, so a signal that arrives first is
 * found in the log, not missed. A wall-clock deadline on each wait only bounds
 * a hang.
 *
 * The boot test waits on page events the same way: the sign-up redirect's
 * navigation, the signed-in nav in the DOM (Playwright's locator wait, which
 * re-checks as the page renders), and the worker's `ready` promise. One boot
 * budget (`BOOT_BUDGET_MS`) bounds them together, sized from runs under load,
 * and each step that overruns it names itself. Every later test needs what
 * boot leaves behind (the controlled page, the user's id), so each first
 * checks that boot completed and fails with that message rather than with
 * whatever its first step trips over.
 *
 * Teardown closes the browser, then the app, each under its own budget
 * (`BROWSER_CLOSE_BUDGET_MS`, `APP_CLOSE_BUDGET_MS`), measured under load. An
 * overrun names its step, and the app still closes after the browser's
 * overran.
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

/** A `legation:*` message the page relayed from the worker (a `PageSignal`). */
type Signal = { readonly type: string } & Readonly<Record<string, unknown>>;

/** The wall-clock instant `ms` from now: a safety bound for a wait, not a timing assumption. */
const deadlineIn = (ms: number): number => Date.now() + ms;

/** What is left of `deadline`, at least 1 ms (Playwright reads a `timeout` of 0 as "no limit"). */
const remaining = (deadline: number): number => Math.max(deadline - Date.now(), 1);

/**
 * `work`, or a rejection naming `phase` and `step` once `deadline` passes: a
 * bound for a wait that has no timeout of its own (a promise awaited inside
 * `page.evaluate`, `browser.close()`, the app's shutdown).
 */
const within = <A>(phase: string, step: string, deadline: number, work: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${phase}: ${step} did not happen within the ${phase} budget`)),
      remaining(deadline)
    );
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
};

/**
 * The worker's signals in arrival order. `mark` is the cursor a wait starts
 * from; `next` returns the first matching signal at or after it, parking
 * until one is recorded, and rejects at `deadline`.
 */
const makeSignals = () => {
  const log: Array<Signal> = [];
  let parked: Array<() => void> = [];

  const record = (signal: Signal): void => {
    log.push(signal);
    const woken = parked;
    parked = [];
    for (const wake of woken) wake();
  };

  const arrival = (awaiting: string, deadline: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${awaiting} from the worker before the safety deadline`)),
        Math.max(deadline - Date.now(), 0)
      );
      parked.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  const next = async (
    from: number,
    type: string,
    deadline: number,
    match: (signal: Signal) => boolean = () => true
  ): Promise<{ readonly index: number; readonly signal: Signal }> => {
    let cursor = from;
    for (;;) {
      for (; cursor < log.length; cursor++) {
        const signal = log[cursor]!;
        if (signal.type === type && match(signal)) return { index: cursor, signal };
      }
      await arrival(type, deadline);
    }
  };

  return { record, mark: () => log.length, next };
};

const served = (result: Fetched) => result.servedAt !== null && result.servedAt !== "";

const USER = { name: "Ada", email: "ada@example.test", password: "correct horse battery" };

const firstPage = readPath(productPage({}));
const keyboardsPage = readPath(productPage({ categoryId: "c-keyboards" }));

let app: App;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const signals = makeSignals();
/**
 * The boot test's budget for everything after the account page's form is
 * filled: the sign-up round trip and redirect, the signed-in render and the
 * worker taking control. A safety bound on event-driven waits, not a timing
 * assumption. On a 4-core host these steps took 3.5 s at a load average of
 * ~63, and the whole boot test 8 s with the load climbing from 75 to 97
 * (#509); the old 30 s test budget ran out near 105, so this leaves an order
 * of magnitude over what was measured.
 */
const BOOT_BUDGET_MS = 60_000;
/**
 * Teardown's budget for closing the browser: a safety bound on Playwright's
 * `browser.close()`, not a timing assumption. On a 4-core host it took
 * 0.3–2.3 s at a load average of 40–60, and 16 s and 22 s at 82–89 (#522),
 * so this leaves room over the worst measured.
 */
const BROWSER_CLOSE_BUDGET_MS = 60_000;
/**
 * Teardown's budget for closing the app. Its sync server shuts down within
 * `NodeHttpServer`'s 20 s graceful-shutdown bound, which it used to reach on
 * every run: the front left the carriers' connections open (#522). With
 * them closed first it took 5 ms–2.5 s at a load average of 50–89.
 */
const APP_CLOSE_BUDGET_MS = 30_000;
/** The signed-up user's id (Better Auth's), set once boot has completed. */
let userId: string | undefined;

/**
 * The user's id, or a failure saying boot did not complete: every test after
 * boot runs on the page and the account boot leaves behind, so without them
 * its own first failure would only be a symptom.
 */
const booted = (): string => {
  if (userId === undefined) {
    throw new Error(
      "boot did not complete (see the boot test's failure): no signed-up user and no controlled page to run on"
    );
  }
  return userId;
};
/** The network's document for the first catalog page, from demonstration 1. */
let firstPageFromNetwork: string;

describe("the façade in a browser: plain fetch over the service worker's replica (#168)", () => {
  beforeAll(async () => {
    const executablePath = chromium.executablePath();
    if (!existsSync(executablePath)) {
      throw new Error(
        `Chromium is not installed at ${executablePath}. Install it with ` +
          "`pnpm exec playwright-core install chromium` (or point PLAYWRIGHT_BROWSERS_PATH at " +
          "an existing Playwright browser directory). This test fails rather than skips."
      );
    }
    app = await serveApp();
    browser = await chromium.launch({ executablePath });
    context = await browser.newContext();
    await context.exposeBinding("legationSignal", (_source, signal: Signal) => {
      signals.record(signal);
    });
    await context.addInitScript(() => {
      navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: unknown } | undefined;
        if (typeof data?.type === "string" && data.type.startsWith("legation:")) {
          (window as unknown as { legationSignal: (signal: unknown) => void }).legationSignal(data);
        }
      });
    });
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    // Each step has its own budget, so the app still closes when the
    // browser's close overruns, and an overrun names its step.
    const failures: Array<unknown> = [];
    const step = async (name: string, budget: number, close: () => Promise<void>) => {
      try {
        await within("teardown", name, deadlineIn(budget), close());
      } catch (error) {
        failures.push(error);
      }
    };
    if (browser !== undefined) {
      await step("browser.close", BROWSER_CLOSE_BUDGET_MS, () => browser.close());
    }
    if (app !== undefined) await step("app.close", APP_CLOSE_BUDGET_MS, () => app.close());
    if (failures.length > 1) throw new AggregateError(failures, "teardown: both steps failed");
    if (failures.length === 1) throw failures[0];
  }, BROWSER_CLOSE_BUDGET_MS + APP_CLOSE_BUDGET_MS + 10_000);

  it("boots: signs up, the worker controls the page, the engine serves the shell's pins", async () => {
    await page.goto(`${app.origin}/account`);
    const signup = page.locator('form[action="?/signup"]');
    await signup.locator('input[name="name"]').fill(USER.name);
    await signup.locator('input[name="email"]').fill(USER.email);
    await signup.locator('input[name="password"]').fill(USER.password);
    const deadline = deadlineIn(BOOT_BUDGET_MS);
    // The form action redirects home; the layout renders the signed-in nav
    // from the session the action set. Both waits are on the page's events.
    await Promise.all([
      page.waitForURL(`${app.origin}/`, { timeout: remaining(deadline) }),
      signup.locator("button").click({ timeout: remaining(deadline) }),
    ]);
    await page
      .locator("nav", { hasText: `signed in as ${USER.name}` })
      .waitFor({ state: "visible", timeout: remaining(deadline) });
    const users = await Effect.runPromise(
      app.sql<{ id: string }>`SELECT id FROM user WHERE email = ${USER.email}`
    );
    expect(users).toHaveLength(1);

    // The worker: registered by Kit, `clients.claim()`ed on activation, so
    // the page is controlled without a reload — reload once if not.
    const workerReady = () =>
      within(
        "boot",
        "the service worker's activation",
        deadline,
        page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        })
      );
    await workerReady();
    if (await page.evaluate(() => navigator.serviceWorker.controller === null)) {
      await page.reload({ timeout: remaining(deadline) });
      await workerReady();
    }
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    userId = users[0]!.id;
  }, BOOT_BUDGET_MS + 15_000);

  it("1. online: an uncovered URL is the network's; a covered one, once pulled, is the replica's — same bytes", async () => {
    booted();
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
    // shell; a pin's rows land on a pull (a poke, or the 15-second backstop).
    // Until a pull has landed for every registration the page needs, the
    // façade forwards the request (ADR-0029 section 3, #426), so the network
    // answers. Each pull the worker reports is the moment to read the replica:
    // the read is kept once it is served with the network's body, byte for
    // byte, and otherwise the next pull is awaited.
    firstPageFromNetwork = (await fromNetwork(context, app.origin, firstPage)).body;
    const deadline = deadlineIn(40_000);
    let local: Fetched;
    let cursor = 0;
    do {
      const landed = await signals.next(cursor, "legation:pull-landed", deadline);
      cursor = landed.index + 1;
      local = await fetched(page, firstPage);
    } while (!(served(local) && content(local.body) === content(firstPageFromNetwork)));
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
    await page.locator("h1", { hasText: "Studio Headphones" }).waitFor({ state: "visible" });
  }, 60_000);

  it("2. offline: the covered URL is served from the replica, header present, same bytes", async () => {
    booted();
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const local = await fetched(page, firstPage);
    expect(local.status).toBe(200);
    expect(served(local)).toBe(true);
    expect(content(local.body)).toBe(content(firstPageFromNetwork));
  }, 15_000);

  it("3. offline: an uncovered URL is the 503 `offline` error document, by either half of §4", async () => {
    booted();
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
    const userId = booted();
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
    // carriers down the push cannot reach the server. The worker reports the
    // journaled write after it is appended, and the overlay is applied under
    // the same lock the façade's read takes, so the read after the signal
    // sees the line.
    const navigation = await page.goto(`${app.origin}/product/p-01`);
    expect(navigation?.fromServiceWorker()).toBe(true);
    const journaled = signals.mark();
    await page.locator("button", { hasText: "Add to cart" }).first().click();
    await signals.next(journaled, "legation:mutation-journaled", deadlineIn(10_000));
    const pending = await fetched(page, cartPath);
    expect(pending.status).toBe(200);
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
    // catches up. The worker reports the acknowledged push once the server has
    // answered it, so the server's table is read after that signal.
    const pushed = signals.mark();
    app.carriers(true);
    await context.setOffline(false);
    await signals.next(
      pushed,
      "legation:push-completed",
      deadlineIn(20_000),
      (signal) => typeof signal.mutations === "number" && signal.mutations >= 1
    );
    const converged = await Effect.runPromise(
      app.sql<{ id: string }>`SELECT id FROM cartItems WHERE userId = ${userId}`
    );
    expect(converged.map((row) => row.id)).toEqual([line.id]);
  }, 45_000);
});
