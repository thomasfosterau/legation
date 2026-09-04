/**
 * The service worker — the app's data-fetching, sync, and offline engine
 * (ADR-0010's recommended deployment).
 *
 * The ClientEngine lives HERE, over IndexedDB (durable journal + rows, all
 * IndexedDB access off the main thread) and the WebSocket→HTTP transport
 * stack. Tabs hold no engine at all: each runs a thin `Mirror` over a
 * BroadcastChannel, receiving materialized rows and resolved joins from
 * this host (`ServiceWorkerHost`), so the main thread does little besides
 * rendering. A killed worker rehydrates losslessly from IndexedDB.
 *
 * The engine boots on a config handshake: tabs broadcast their client-group
 * id (from the `legation-client-group` cookie, which this worker cannot
 * read) on `legation-config`, and the first message starts the host.
 *
 * The `fetch` listener composes three fronts in ADR-0029 §1's order:
 *
 * 1. **The JSON:API façade** (`lib/facade.ts`), once the engine has booted:
 *    a `GET` of a catalog or account URL that the shell's pins cover is
 *    answered from the replica — `x-legation-served-at` names the cookie —
 *    and never reaches the cache. An uncovered one falls through; offline
 *    (`navigator.onLine` false, or the forward rejected at the transport)
 *    it becomes the 503 `offline` document (ADR-0029 §4).
 * 2. **The HTTP cache** (`CacheApiHttpCache`): built assets cache-first,
 *    page navigations stale-while-revalidate, exactly as before the façade.
 * 3. **The network**, request unchanged. Sync traffic (`/sync*`) passes
 *    straight through — the engine's journal + pull pipeline owns that path.
 *
 * The app still works fully without this worker (the SSR + JSON:API naive
 * experience).
 */
/// <reference lib="webworker" />
import { build, files, version } from "$service-worker";
import { Effect, Layer } from "effect";
import { IndexedDb } from "@effect/platform-browser";
import { ClientView, Coverage, type HttpCache } from "@legation/effect/internal";
import { CacheApiHttpCache } from "@legation/browser";
import type { JsonApiFacade } from "@legation/jsonapi";
import { nodes } from "./lib/domain.js";
import { makeFacade } from "./lib/facade.js";
import { runHost } from "./lib/host.js";

declare const self: ServiceWorkerGlobalScope;

// ─── HTTP cache ──────────────────────────────────────────────────────────────

const ASSETS = new Set([...build, ...files]);
const CACHE_NAME = `commerce-${version}`;

const policy = (request: Request): HttpCache.HttpCachePolicy | undefined => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/sync")) return undefined; // engine-owned
  if (ASSETS.has(url.pathname)) {
    return { tags: ["assets"], staleTime: "7 days", timeToLive: "30 days" };
  }
  if (request.mode === "navigate") {
    return { tags: ["pages"], staleTime: "5 seconds", timeToLive: "1 hour" };
  }
  return undefined;
};

/** The HTTP cache front: stale-while-revalidate under the request's policy. */
const viaCache = (event: FetchEvent): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const store = yield* CacheApiHttpCache.open(CACHE_NAME);
    const handle = CacheApiHttpCache.fetchHandler({ store, policy });
    const result = yield* handle(event.request);
    if (result.revalidate !== undefined) {
      event.waitUntil(Effect.runPromise(Effect.ignore(result.revalidate)));
    }
    return result.response;
  });

// ─── The façade ──────────────────────────────────────────────────────────────

/** Installed when the engine boots; until then JSON:API GETs are the network's. */
let facade: JsonApiFacade.FetchHandler | undefined;

/**
 * The network, last. A JSON:API request the façade recognised but could not
 * cover, whose forward rejected at the transport, is offline by ADR-0029
 * §4's definition and gets the 503 `offline` document (with the replica's
 * cookie, as every façade answer) rather than a failed fetch; anything else
 * fails as it always did.
 */
const network = (request: Request, candidate: boolean): Promise<Response> =>
  fetch(request).catch((error: unknown) => {
    if (candidate && facade !== undefined) return Effect.runPromise(facade.offline);
    throw error;
  });

/** Façade, then cache, then network (ADR-0029 §1). */
const respond = async (event: FetchEvent, candidate: boolean): Promise<Response> => {
  const { request } = event;
  try {
    const local = facade === undefined ? undefined : await Effect.runPromise(facade.handle(request));
    if (local !== undefined) return local;
    if (policy(request) !== undefined) return await Effect.runPromise(viaCache(event));
  } catch {
    // A failed façade or cache is never fatal: the network answers either way.
  }
  return network(request, candidate);
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const candidate = facade?.matches(request) === true;
  if (!candidate && policy(request) === undefined) return;
  event.respondWith(respond(event, candidate));
});

// ─── The engine host ─────────────────────────────────────────────────────────

/** IndexedDB from the worker's own globals (no `window` here). */
const indexedDbLayer = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB: self.indexedDB, IDBKeyRange })
);

/** A dead engine in a worker is undebuggable — relay failures to the tabs. */
const reportToClients = (message: string) =>
  self.clients
    .matchAll()
    .then((clients) => clients.forEach((client) => client.postMessage({ legationInfo: message })))
    .catch(() => undefined);

// Boot on the first tab's config handshake; ignore repeats.
let started = false;
const config = new BroadcastChannel("legation-config");
config.addEventListener("message", (event) => {
  const clientGroupId = (event.data as { clientGroupId?: string } | undefined)?.clientGroupId;
  if (started || typeof clientGroupId !== "string" || clientGroupId.length === 0) return;
  started = true;
  void reportToClients(`engine host starting (group ${clientGroupId})`);
  void Effect.runPromise(
    runHost({
      clientGroupId,
      clientId: `sw-${clientGroupId}`,
      syncOrigin: self.location.origin,
      indexedDb: indexedDbLayer,
      // The façade reads the served engine through the host's own
      // registrations: the tabs' pins, refcounted per mirror, are the ledger.
      onStart: (host) => {
        facade = makeFacade({
          view: ClientView.fromEngine(host.engine),
          coverageOf: Coverage.coverageOf(nodes, host.registrations),
          cookie: host.cookie,
        });
        void reportToClients("jsonapi façade serving covered GETs from the replica");
      },
    })
  ).catch((error) => {
    started = false; // a failed boot may retry on the next handshake
    facade = undefined;
    void reportToClients(`engine host failed: ${String(error)}`);
  });
});
