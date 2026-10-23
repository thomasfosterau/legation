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
 *    A `POST /jsonapi/reviews` with a client id is a **façade write**
 *    (ADR-0030): offline it is journaled and answered `202` with a write
 *    receipt; online it is forwarded (a clone kept first), and a forward
 *    that rejects at the transport is journaled from that clone instead.
 * 3. **The network**, request unchanged. Sync traffic (`/sync*`) passes
 *    straight through — the engine's journal + pull pipeline owns that path.
 *
 * The app still works fully without this worker (the SSR + JSON:API naive
 * experience).
 */
/// <reference lib="webworker" />
import { version } from "$app/env";
import { assets, immutable } from "$app/manifest";
import { asset, type AssetPath } from "$app/paths";
import { Effect, Layer } from "effect";
import { IndexedDb } from "@effect/platform-browser";
import { ClientView, Coverage, type HttpCache } from "@thomasfosterau/legation-effect/internal";
import { CacheApiHttpCache } from "@thomasfosterau/legation-browser";
import type { JsonApiFacade } from "@thomasfosterau/legation-jsonapi";
import { nodes } from "./lib/domain.js";
import { makeFacade } from "./lib/facade.js";
import { runHost } from "./lib/host.js";

declare const self: ServiceWorkerGlobalScope;

// ─── HTTP cache ──────────────────────────────────────────────────────────────

/** The build's immutable files and the static directory, as the URLs the browser requests them by. */
const ASSETS = new Set(
  [...immutable, ...assets].map(({ path }) => asset(path as AssetPath))
);
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
 * The network, last. A JSON:API request the façade recognised, whose forward
 * rejected at the transport, is offline by ADR-0029 §4's definition: a read
 * gets the 503 `offline` document (with the replica's cookie, as every façade
 * answer), and a write is journaled from the clone taken before forwarding
 * and answered with its `202` receipt (ADR-0030 §3). A forwarded write that
 * succeeds tells the façade, which pulls in the background. Anything else
 * fails as it always did.
 */
const network = (event: FetchEvent, candidate: Request | undefined): Promise<Response> =>
  fetch(event.request).then(
    (response) => {
      if (candidate !== undefined && facade !== undefined) {
        event.waitUntil(Effect.runPromise(facade.forwarded(candidate, response)));
      }
      return response;
    },
    (error: unknown) => {
      if (candidate !== undefined && facade !== undefined) {
        return Effect.runPromise(facade.offline(candidate));
      }
      throw error;
    }
  );

/** Façade, then cache, then network (ADR-0029 §1). */
const respond = async (event: FetchEvent, candidate: Request | undefined): Promise<Response> => {
  const { request } = event;
  try {
    const local = facade === undefined ? undefined : await Effect.runPromise(facade.handle(request));
    if (local !== undefined) return local;
    if (policy(request) !== undefined) return await Effect.runPromise(viaCache(event));
  } catch {
    // A failed façade or cache is never fatal: the network answers either way.
  }
  return network(event, candidate);
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Every method: the façade's writes are `POST` / `PATCH` / `DELETE` (ADR-0030 §5). A candidate is
  // cloned before anything reads or forwards it, so its body is still there for `offline`.
  const candidate = facade?.matches(request) === true ? request.clone() : undefined;
  if (candidate === undefined && (request.method !== "GET" || policy(request) === undefined)) return;
  event.respondWith(respond(event, candidate));
});

// ─── The engine host ─────────────────────────────────────────────────────────

/** IndexedDB from the worker's own globals (no `window` here). */
const indexedDbLayer = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB: self.indexedDB, IDBKeyRange })
);

/** Post a message to every client page this worker controls. */
const toClients = (message: unknown) =>
  self.clients
    .matchAll()
    .then((clients) => clients.forEach((client) => client.postMessage(message)))
    .catch(() => undefined);

/** A dead engine in a worker is undebuggable — relay failures to the tabs. */
const reportToClients = (message: string) => toClients({ legationInfo: message });

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
      // Each completed pull, journaled write and acknowledged push, as a `legation:*` message to the
      // tabs (`PageSignal`): the browser test waits on these rather than polling the replica.
      onSignal: (signal) => void toClients(signal),
      // The façade reads the served engine through the host's own
      // registrations: the tabs' pins, refcounted per mirror, are the ledger.
      onStart: (host) => {
        const view = ClientView.fromEngine(host.engine);
        facade = makeFacade({
          view,
          coverageOf: Coverage.coverageOf(nodes, view.query, host.registrations),
          cookie: host.cookie,
          // Façade writes journal into this worker's engine, never over the mirror channel.
          mutate: host.engine.mutateWithAck,
          pull: host.engine.pull,
        });
        void reportToClients("jsonapi façade serving covered GETs and journaling writes");
      },
    })
  ).catch((error) => {
    started = false; // a failed boot may retry on the next handshake
    facade = undefined;
    void reportToClients(`engine host failed: ${String(error)}`);
  });
});
