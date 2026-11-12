/**
 * @thomasfosterau/legation-browser/http-cache
 *
 * The Cache API HTTP cache on its own entry, for a service worker that wants
 * the stale-while-revalidate fetch handler without the engine (#678): this
 * entry reaches neither the sync engine nor the invalidation feed, so a
 * bundler keeps only the cache. Collection-driven invalidation
 * (`HttpCacheInvalidation`) is the opt-in on the root entry.
 *
 * - `CacheApiHttpCache`: ResponseCacheStore over the Cache API plus the
 *   stale-while-revalidate fetch handler (also on the root entry)
 * - `HttpCache`: core's runtime-agnostic HTTP cache module (the policy and
 *   metadata types, the store service tag and the tag convention),
 *   re-exported so a service worker needs only this entry
 */

export * as CacheApiHttpCache from "./CacheApiHttpCache.js";
// The runtime-agnostic HTTP cache module lives in core (ADR-0006's
// dependency rule); re-exported so the cache needs only this entry.
export { HttpCache } from "@thomasfosterau/legation/internal";
