/**
 * @legation/browser
 *
 * Browser-runtime adapters for the legation engine (ADR-0010):
 *
 * - `IndexedDbClientStore`: durable ClientStore over IndexedDB
 * - `BroadcastMirrorChannel`: the mirror seam's BroadcastChannel binding
 *   (the seam itself — `MirrorChannel` / `MirrorProtocol` / `EngineHost` /
 *   `TabMirror` — is runtime-agnostic and lives in `@legation/effect`;
 *   re-exported here for compatibility)
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
export * as BroadcastMirrorChannel from "./BroadcastMirrorChannel.js";
export * as ServiceWorkerHost from "./ServiceWorkerHost.js";
// The runtime-agnostic mirror seam lives in core (ADR-0006's dependency
// rule); re-exported here so existing imports keep working.
export { EngineHost, MirrorChannel, MirrorProtocol, TabMirror } from "@legation/effect";
export * as CacheApiHttpCache from "./CacheApiHttpCache.js";
export * as HttpCacheInvalidation from "./HttpCacheInvalidation.js";
export * as BrowserConnectivity from "./BrowserConnectivity.js";
