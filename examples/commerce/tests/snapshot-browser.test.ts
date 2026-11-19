/**
 * The SSR snapshot path end to end, in a browser, with the engine in the
 * service worker (#146): the built commerce app (`tests/support/app.ts`)
 * driven with Playwright over the pre-installed Chromium, in a fresh browser
 * context (an empty IndexedDB, no worker installed).
 *
 * 1. **First visit.** The root layout's `load` renders the shell's snapshot
 *    under the browser's client group (`server/snapshot.ts`); the catalog's
 *    first paint — the server's HTML — has rows, seeded from it. The tab
 *    offers the snapshot to the worker (`createClient`'s `snapshot`); the
 *    worker, booted by that tab's handshake over an empty replica, holds its
 *    first pull for the offer (`hydrationWindow`) and answers `hydrated`. Its
 *    first pull then carries the snapshot's cookie, and the answer is no
 *    reset: the CVR conversation continues where the server left off.
 * 2. **A returning visitor.** A reload renders a new snapshot, but the
 *    worker's replica now holds rows and a cookie: the offer is answered
 *    `NotEmpty`, and the next pull carries the replica's own cookie, not the
 *    new snapshot's.
 *
 * The worker's pulls are observed through its `legation:pull-answered`
 * signals (`PageSignal`, `src/lib/host.ts`): the cookie each request
 * carried, and whether the answer was a `Clear`. The worker's answer to the
 * snapshot is on the nav (`data-hydration`), with the snapshot's cookie
 * (`data-snapshot-cookie`). Waits are on those events, each bounded by a
 * safety deadline, never on the clock.
 *
 * Chromium missing is a failure with the path named, never a skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { serveApp, type App } from "./support/app.js";

/** One pull the worker's engine made, as its signal reports it. */
interface PullAnswered {
  readonly cookie: string | undefined;
  readonly reset: boolean;
}

/** A safety bound on each event-driven wait, sized for a loaded CI host. */
const WAIT_MS = 60_000;

let app: App;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const pulls: Array<PullAnswered> = [];
let woken: Array<() => void> = [];

/** Resolves on the next recorded pull, or at `deadline`. */
const nextSignal = (deadline: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(deadline - Date.now(), 1));
    woken.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** The pull recorded at index `from`, waiting for it up to the safety bound. */
const pullFrom = async (from: number, deadline = Date.now() + WAIT_MS): Promise<PullAnswered> => {
  const pull = pulls[from];
  if (pull !== undefined) return pull;
  if (Date.now() > deadline) throw new Error("no pull from the worker before the safety deadline");
  await nextSignal(deadline);
  return pullFrom(from, deadline);
};

/** The worker's answer to this page's snapshot, once it is on the nav, and the snapshot's cookie. */
const answered = async (): Promise<{ readonly hydration: string; readonly cookie: string }> => {
  const nav = page.locator("nav:not([data-hydration='pending'])");
  await nav.waitFor({ state: "attached", timeout: WAIT_MS });
  return {
    hydration: (await nav.getAttribute("data-hydration")) ?? "",
    cookie: (await nav.getAttribute("data-snapshot-cookie")) ?? "",
  };
};

describe("the SSR snapshot hydrates the service worker's replica (#146)", () => {
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
    await context.exposeBinding("legationPull", (_source, signal: PullAnswered) => {
      pulls.push({ cookie: signal.cookie ?? undefined, reset: signal.reset });
      const wake = woken;
      woken = [];
      for (const resume of wake) resume();
    });
    await context.addInitScript(() => {
      navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: unknown } | undefined;
        if (data?.type === "legation:pull-answered") {
          (window as unknown as { legationPull: (signal: unknown) => void }).legationPull(data);
        }
      });
    });
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  }, 90_000);

  it("first visit: first paint has the snapshot's rows, and the first pull continues from its cookie", async () => {
    const response = await page.goto(`${app.origin}/`);
    // The first paint is the server's markup, seeded from the snapshot.
    const html = (await response?.text()) ?? "";
    expect(html).toContain('data-seed="snapshot"');
    expect(html).toContain("Studio Headphones");

    const { hydration, cookie } = await answered();
    expect(cookie).not.toBe("");
    expect(hydration).toBe("hydrated");

    // The worker's first pull after hydrating: the snapshot's cookie, no reset.
    const first = await pullFrom(0);
    expect(first).toEqual({ cookie, reset: false });
  }, 120_000);

  it("a returning visitor's replica is not clobbered by a later snapshot", async () => {
    // The replica has pulled at least once; its cookie is the last answered pull's successor.
    await pullFrom(0);
    const mark = pulls.length;
    await page.reload();
    const { hydration, cookie } = await answered();
    expect(cookie).not.toBe("");
    expect(hydration).toBe("NotEmpty");
    // The next pull carries the replica's cookie, never the new snapshot's.
    const next = await pullFrom(mark);
    expect(next.cookie).toBeDefined();
    expect(next.cookie).not.toBe(cookie);
    expect(next.reset).toBe(false);
  }, 120_000);
});
