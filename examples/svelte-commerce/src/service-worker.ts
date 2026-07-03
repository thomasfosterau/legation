/**
 * The service worker — the app's HTTP cache (`@legation/browser`'s
 * CacheApiHttpCache over the Cache API): built assets are served
 * cache-first (immutable), page navigations stale-while-revalidate, so a
 * repeat visit paints from cache while a fresh SSR response revalidates in
 * the background — and the app still works fully without this worker.
 *
 * Sync traffic (`/sync`, `/sync-ws`) passes straight through: the engine's
 * own journal + pull pipeline owns that path (caching it would fight the
 * CVR conversation). Hosting the engine itself in here (ADR-0010's tab
 * mirrors over `ClientView`) is the documented next step for this example.
 */
/// <reference lib="webworker" />
import { build, files, version } from "$service-worker";
import { Effect } from "effect";
import { CacheApiHttpCache } from "@legation/browser";
import type { HttpCache } from "@legation/effect";

declare const self: ServiceWorkerGlobalScope;

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
