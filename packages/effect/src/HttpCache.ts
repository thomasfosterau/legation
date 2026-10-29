/**
 * HttpCache
 *
 * The separate service-worker HTTP caching module (distinct from collection
 * sync; see CONTEXT.md). Core defines the runtime-agnostic service: a
 * Request/Response cache with freshness windows, stale-while-revalidate,
 * and tag-based invalidation. The browser package implements the store over
 * the Cache API (fixing the former text-only body limitation) and closes the
 * loop on collection- and row-driven invalidation: `HttpCacheInvalidation`
 * maps an engine's collection and row changes (the `collection:{name}` /
 * `collection:{name}:{id}` tag convention, #207) onto `invalidateTags`, so a
 * synced change evicts the responses tagged for what it touched.
 * Implementations for edge runtimes can back the store with their own
 * primitives.
 *
 * Phase 3 module: interfaces are final-shape; the fetch-event handler and
 * Cache API store land with the browser host.
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import type { StoreError } from "./Errors.js";

/** Cache metadata kept alongside a stored Response. */
export interface CachedResponseMeta {
  readonly url: string;
  readonly storedAt: number;
  readonly staleAt: number;
  readonly expiresAt: number | undefined;
  readonly tags: ReadonlyArray<string>;
}

/** A pluggable store of Request/Response pairs (Cache API in browsers). */
export interface ResponseCacheStore {
  readonly match: (
    request: Request
  ) => Effect.Effect<
    { readonly response: Response; readonly meta: CachedResponseMeta } | undefined,
    StoreError
  >;
  readonly put: (
    request: Request,
    response: Response,
    meta: CachedResponseMeta
  ) => Effect.Effect<void, StoreError>;
  readonly delete: (request: Request) => Effect.Effect<void, StoreError>;
  /** Remove every entry carrying any of the tags. */
  readonly invalidateTags: (tags: ReadonlyArray<string>) => Effect.Effect<void, StoreError>;
}

/**
 * The {@link ResponseCacheStore} service tag, for apps that provide a store by layer;
 * the fetch handlers take it as an option.
 */
export const ResponseCacheStore = Context.Service<ResponseCacheStore>(
  "@thomasfosterau/legation-effect/ResponseCacheStore"
);

/** Per-route caching policy. */
export interface HttpCachePolicy {
  readonly staleTime: Duration.Input;
  readonly timeToLive?: Duration.Input | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

// ─── The tag convention (#207, #206) ─────────────────────────────────────────
//
// One spelling for every cache that evicts by what a write touched: the
// browser's Cache API (`HttpCacheInvalidation` in `@thomasfosterau/legation-browser`)
// and the edge (`EdgeInvalidation` in `@thomasfosterau/legation-cloudflare`).

/** The coarse tag of a collection: `collection:{name}`. Every response enumerating (part of) it carries it. */
export const tagFor = (collection: string): string => `collection:${collection}`;

/** The fine tag of one row: `collection:{name}:{id}`. A response carries one per row it contains. */
export const fineTagFor = (collection: string, id: string): string => `${tagFor(collection)}:${id}`;

/** The collections and individual rows a change touched. */
export interface Touched {
  readonly collections: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{ readonly collection: string; readonly id: string }>;
}

/** Options for {@link evictionTags}: the tag spelling, defaulting to {@link tagFor} and {@link fineTagFor}. */
export interface EvictionTagOptions {
  readonly tagFor?: (collection: string) => string;
  readonly fineTagFor?: (collection: string, id: string) => string;
}

/**
 * The tags to evict for a change, each once: the coarse tag of every touched
 * collection **and** the fine tag of every touched row. The coarse eviction is
 * not redundant with the fine one: a cached aggregate (a list, a feed, a
 * sitemap) can be staled by a row it does not yet contain, such as a newly
 * published one, and only the coarse tag reaches it.
 */
export const evictionTags = (
  touched: Touched,
  options: EvictionTagOptions = {}
): ReadonlyArray<string> => {
  const coarse = options.tagFor ?? tagFor;
  const fine = options.fineTagFor ?? fineTagFor;
  return Arr.dedupe([
    ...touched.collections.map((collection) => coarse(collection)),
    ...touched.rows.map((row) => fine(row.collection, row.id)),
  ]);
};
