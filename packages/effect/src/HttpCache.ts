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
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StoreError } from "./Errors.js";

/**
 * The cache metadata kept alongside a stored Response, as a schema: a store
 * persists it with the response (the Cache API store, in a header), so its
 * encoded shape is a storage format and keeps its native optional.
 */
export const CachedResponseMeta = Schema.Struct({
  url: Schema.String,
  storedAt: Schema.Finite,
  staleAt: Schema.Finite,
  /** Absent when the entry never expires (no `timeToLive`). */
  expiresAt: Schema.optional(Schema.Finite),
  tags: Schema.Array(Schema.String),
});

/** Cache metadata kept alongside a stored Response. */
export type CachedResponseMeta = typeof CachedResponseMeta.Type;

/** A stored response and the metadata it was stored with: a {@link ResponseCacheStore} hit. */
export interface CachedResponse {
  readonly response: Response;
  readonly meta: CachedResponseMeta;
}

/** A pluggable store of Request/Response pairs (Cache API in browsers). */
export interface ResponseCacheStore {
  /** The entry stored for the request; `None` on a miss. */
  readonly match: (request: Request) => Effect.Effect<Option.Option<CachedResponse>, StoreError>;
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
  "@thomasfosterau/legation/ResponseCacheStore"
);

/** Per-route caching policy. */
export interface HttpCachePolicy {
  /** How long a stored response is served without revalidating. */
  readonly staleTime: Duration.Input;
  /** How long a stored response may be served at all (stale ones revalidate); no limit when absent. */
  readonly timeToLive?: Duration.Input;
  /** The tags stored with the response, for {@link ResponseCacheStore.invalidateTags}. */
  readonly tags?: ReadonlyArray<string>;
  /**
   * Whether a network response may be stored; defaults to `response.ok`. A
   * response it refuses is still answered, just not cached (e.g. cache only
   * `Cache-Control: public` responses).
   */
  readonly cacheable?: (response: Response) => boolean;
}

// ─── The tag convention (#207, #206) ─────────────────────────────────────────
//
// One spelling for every cache that evicts by what a write touched: the
// browser's Cache API (`HttpCacheInvalidation` in `@thomasfosterau/legation-browser`)
// and the edge (`EdgeInvalidation` in `@thomasfosterau/legation-alchemy-cloudflare`).

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
