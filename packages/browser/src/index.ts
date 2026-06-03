/**
 * @thomasfosterau/effect-sync-browser
 *
 * Browser-runtime adapters for the Effect-native sync engine. These modules
 * implement core's `ClientTransport` and `CacheStore` interfaces against
 * browser platform APIs:
 *
 * - **WebSocketTransport** — a `ClientTransport` over the `WebSocket` global,
 *   with auto-reconnect and exponential backoff. Also runs in Node 22+.
 * - **IndexedDbCacheStore** — a persistent `CacheStore` over `indexedDB`,
 *   so cached data survives page reloads.
 *
 * Per ADR-0006, all browser-runtime-specific code lives in this package so
 * the core engine stays platform-agnostic.
 */

export * as WebSocketTransport from "./WebSocketTransport.js";
export * as IndexedDbCacheStore from "./IndexedDbCacheStore.js";
