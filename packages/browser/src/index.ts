/**
 * @thomasfosterau/effect-sync-browser
 *
 * Browser-runtime adapters for the effect-sync engine (v2 architecture,
 * ADR-0010). Phase 3 deliverables, landing here:
 *
 * - `IndexedDbClientStore`: durable `ClientStore` over IndexedDB
 * - `ServiceWorkerHost`: the recommended engine host (per-origin
 *   singleton, crash-tolerant, Background Sync triggers)
 * - `TabMirror`: per-tab in-memory mirror + BroadcastChannel transport
 * - `CacheApiResponseStore`: `ResponseCacheStore` over the Cache API
 */
export const status = "v2 rebuild: browser adapters land in phase 3" as const;
