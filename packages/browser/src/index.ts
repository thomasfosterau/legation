/**
 * @legation/browser
 *
 * Browser-runtime adapters for the legation engine (ADR-0010):
 *
 * - `IndexedDbClientStore`: durable ClientStore over IndexedDB
 * - `MirrorChannel` / `MirrorProtocol` / `EngineHost` / `TabMirror`: the
 *   tab-mirror seam — per-tab in-memory mirrors served by the engine host
 *   over BroadcastChannel
 * - `ServiceWorkerHost`: the recommended host composition (engine sync
 *   loop + mirror serving) for the per-origin service-worker singleton
 * - `CacheApiHttpCache`: ResponseCacheStore over the Cache API plus the
 *   stale-while-revalidate fetch handler
 * - `HttpCacheInvalidation`: drives HTTP-cache tag invalidation from an
 *   engine's collection changes (the `collection:{name}` tag convention)
 * - `BrowserConnectivity`: layers `navigator.onLine` + focus signals onto a
 *   `ClientTransport` so the sync loop's reconnect/focus triggers fire
 */

export * as IndexedDbClientStore from "./IndexedDbClientStore.js";
export * as MirrorChannel from "./MirrorChannel.js";
export * as MirrorProtocol from "./MirrorProtocol.js";
export * as EngineHost from "./EngineHost.js";
export * as TabMirror from "./TabMirror.js";
export * as ServiceWorkerHost from "./ServiceWorkerHost.js";
export * as CacheApiHttpCache from "./CacheApiHttpCache.js";
export * as HttpCacheInvalidation from "./HttpCacheInvalidation.js";
export * as BrowserConnectivity from "./BrowserConnectivity.js";
