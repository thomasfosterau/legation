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

import { Context } from "effect";
import type { Effect } from "effect";
import type { Duration } from "effect";
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

/** The {@link ResponseCacheStore} service. */
export const ResponseCacheStore = Context.Service<ResponseCacheStore>(
  "@legation/effect/ResponseCacheStore"
);

/** Per-route caching policy. */
export interface HttpCachePolicy {
  readonly staleTime: Duration.Input;
  readonly timeToLive?: Duration.Input | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}
