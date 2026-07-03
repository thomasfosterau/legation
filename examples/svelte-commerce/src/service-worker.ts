/**
 * The service worker — the app's data-fetching, sync, and offline engine
 * (ADR-0010's recommended deployment).
 *
 * The ClientEngine lives HERE, over IndexedDB (durable journal + rows, all
 * IndexedDB access off the main thread) and the WebSocket→HTTP transport
 * stack. Tabs hold no engine at all: each runs a thin `TabMirror` over a
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
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { IndexedDb } from "@effect/platform-browser";
import { ClientEngine, RpcTransport, Transport, type HttpCache } from "@legation/effect";
import {
  BrowserConnectivity,
  CacheApiHttpCache,
  IndexedDbClientStore,
  ServiceWorkerHost,
} from "@legation/browser";
import { mutators, registry } from "./lib/domain.js";

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

const SYNC_HTTP = `${self.location.origin}/sync`;
const SYNC_WS = `${self.location.protocol === "https:" ? "wss" : "ws"}://${self.location.host}/sync-ws`;

/** WS primary + HTTP fallback + connectivity, as one transport layer. */
const transportLayer = (clientGroupId: string): Layer.Layer<Transport.ClientTransport> =>
  Layer.effect(Transport.ClientTransport)(
    Effect.gen(function* () {
      const options = { clientGroupId };
      // Layer.build ties each protocol's resources to the enclosing layer
      // scope (Effect.provide here would finalize them on return).
      const wsContext = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(SYNC_WS)),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerNdjson)
        )
      );
      const ws = yield* RpcTransport.make(options).pipe(Effect.provide(wsContext));
      const httpContext = yield* Layer.build(
        RpcClient.layerProtocolHttp({ url: SYNC_HTTP }).pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(FetchHttpClient.layer)
        )
      );
      const http = yield* RpcTransport.make(options).pipe(Effect.provide(httpContext));
      // primaryTimeout: a hanging WebSocket must not stall sync — time it
      // out, sideline it, serve through HTTP.
      const combined = yield* Transport.withFallback(ws, http, {
        restoreAfter: "30 seconds",
        primaryTimeout: "10 seconds",
      });
      return yield* BrowserConnectivity.withBrowserConnectivity(combined);
    })
  );

/** IndexedDB from the worker's own globals (no `window` here). */
const indexedDbLayer = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB: self.indexedDB, IDBKeyRange })
);

const host = (clientGroupId: string) =>
  ServiceWorkerHost.run({ registry }).pipe(
    Effect.provide(
      ClientEngine.layer({
        clientId: `sw-${clientGroupId}`,
        clientGroupId,
        mutators,
        syncLoop: { pullInterval: "15 seconds", pushDebounce: "300 millis" },
      }).pipe(
        Layer.provide(transportLayer(clientGroupId)),
        Layer.provide(IndexedDbClientStore.layer().pipe(Layer.provide(indexedDbLayer)))
      )
    ),
    Effect.scoped
  );

// Boot on the first tab's config handshake; ignore repeats.
let started = false;
const config = new BroadcastChannel("legation-config");
config.addEventListener("message", (event) => {
  const clientGroupId = (event.data as { clientGroupId?: string } | undefined)?.clientGroupId;
  if (started || typeof clientGroupId !== "string" || clientGroupId.length === 0) return;
  started = true;
  void Effect.runPromise(host(clientGroupId)).catch(() => {
    started = false; // a failed boot may retry on the next handshake
  });
});
