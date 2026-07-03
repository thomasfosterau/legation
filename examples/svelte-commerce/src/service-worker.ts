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
 * Alongside the engine, the worker is the HTTP cache
 * (`CacheApiHttpCache`): built assets cache-first, page navigations
 * stale-while-revalidate. Sync traffic (`/sync*`) passes straight through —
 * the engine's journal + pull pipeline owns that path. The app still works
 * fully without this worker (the SSR + JSON:API naive experience).
 */
/// <reference lib="webworker" />
import { build, files, version } from "$service-worker";
import { Effect, Layer } from "effect";
import { IndexedDb } from "@effect/platform-browser";
import type { HttpCache } from "@legation/effect";
import { CacheApiHttpCache } from "@legation/browser";
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

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (policy(event.request) === undefined) return;
  event.respondWith(
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CacheApiHttpCache.open(CACHE_NAME);
        const handle = CacheApiHttpCache.fetchHandler({ store, policy });
        const result = yield* handle(event.request);
        if (result.revalidate !== undefined) {
          event.waitUntil(Effect.runPromise(Effect.ignore(result.revalidate)));
        }
        return result.response;
      })
    ).catch(() => fetch(event.request))
  );
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
    })
  ).catch((error) => {
    started = false; // a failed boot may retry on the next handshake
    void reportToClients(`engine host failed: ${String(error)}`);
  });
});
