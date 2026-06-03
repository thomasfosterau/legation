/**
 * HttpCache
 *
 * HTTP request/response caching for service-worker `fetch` event handling
 * and edge runtimes, layered on top of `WriteThroughCache`.
 *
 * The flow mirrors a service worker: a `fetch` handler receives a
 * `Request`, derives a cache key, and either serves a cached `Response` or
 * goes to the network (the `upstream` effect) and caches the result.
 *
 * - **GET (cacheable)**: read-through. The first request hits upstream and
 *   caches the response; subsequent requests within the freshness window
 *   are served from cache.
 * - **POST/PUT/DELETE (non-cacheable)**: pass through to upstream, and on
 *   success invalidate any cached entries for the same URL (write-through
 *   semantics — a mutation evicts the stale cached representation).
 *
 * Bodies are cached as text (`response.text()`). Caching binary bodies
 * (`ArrayBuffer`/`Blob`) is a known limitation: such responses round-trip
 * through `string` and may be corrupted. Use text/JSON responses with this
 * cache, or extend `CachedResponse` to carry a base64 payload.
 */

import { StoreError, SyncKey } from "@thomasfosterau/effect-sync-core";
import { Effect, type Duration } from "effect";
import * as WriteThroughCache from "./WriteThroughCache.js";

/**
 * A request shape accepted by the HTTP cache: either a Fetch API `Request`
 * or a plain object with `url` and `method`.
 */
export type HttpRequestLike = Request | { readonly url: string; readonly method: string };

const methodOf = (request: HttpRequestLike): string => request.method.toUpperCase();

const urlOf = (request: HttpRequestLike): string => request.url;

const headerValue = (request: HttpRequestLike, header: string): string | null => {
  // Only real `Request` objects expose a Headers map.
  if (typeof Request !== "undefined" && request instanceof Request) {
    return request.headers.get(header);
  }
  return null;
};

/**
 * Derive a `SyncKey` for an HTTP request.
 *
 * The key is `["http-cache", method, url, ...varyHeaderValues]`, where the
 * vary header values are appended in the order given so that requests that
 * differ only by a `Vary`-relevant header are cached separately.
 */
export const requestKey = (
  request: HttpRequestLike,
  options?: { readonly varyHeaders?: ReadonlyArray<string> | undefined }
): SyncKey.SyncKey => {
  const base: ReadonlyArray<SyncKey.SyncKeyPart> = [
    "http-cache",
    methodOf(request),
    urlOf(request),
  ];
  const vary = options?.varyHeaders ?? [];
  const varyParts = vary.map((header) => headerValue(request, header));
  return [...base, ...varyParts];
};

/**
 * A serializable snapshot of an HTTP response.
 *
 * Bodies are stored as text (see the module note on binary bodies).
 */
export interface CachedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

/**
 * Capture a Fetch `Response` as a `CachedResponse`.
 *
 * The response is cloned before its body is read, so the original
 * `Response` remains usable by the caller.
 */
export const toCachedResponse = (response: Response): Effect.Effect<CachedResponse, StoreError> => {
  const clone = response.clone();
  const headers: Array<readonly [string, string]> = [];
  clone.headers.forEach((value, key) => {
    headers.push([key, value] as const);
  });
  return Effect.tryPromise({
    try: () => clone.text(),
    catch: (cause) =>
      new StoreError({
        message: "Failed to read HTTP response body for caching",
        cause,
      }),
  }).pipe(
    Effect.map((body) => ({
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    }))
  );
};

/**
 * Reconstruct a Fetch `Response` from a `CachedResponse`.
 */
export const fromCachedResponse = (cached: CachedResponse): Response =>
  new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers.map(([key, value]) => [key, value]),
  });

/**
 * Options for the service-worker fetch handler.
 */
export interface HandleFetchOptions<E> {
  readonly request: Request;
  /** The network fetch to run on a cache miss or for non-cacheable methods. */
  readonly upstream: (request: Request) => Effect.Effect<Response, E>;
  /** Eviction window for cached responses. Default: never expires. */
  readonly ttl?: Duration.Input | undefined;
  /** Freshness (stale-while-revalidate) window. Default: stale immediately. */
  readonly swr?: Duration.Input | undefined;
  /** Methods served through the cache. Default `["GET"]`. */
  readonly cacheableMethods?: ReadonlyArray<string> | undefined;
  /** Headers whose values partition the cache (`Vary`). */
  readonly varyHeaders?: ReadonlyArray<string> | undefined;
  /**
   * Predicate deciding whether a response may be cached. Default: any
   * `2xx` status.
   */
  readonly isCacheable?: ((response: CachedResponse) => boolean) | undefined;
}

const isSuccessStatus = (response: CachedResponse): boolean =>
  response.status >= 200 && response.status <= 299;

/**
 * Handle a service-worker `fetch` event through the cache.
 *
 * Cacheable methods (default `GET`) are served read-through: a cached,
 * fresh response is returned without touching the network; otherwise the
 * `upstream` effect runs and its result is cached when `isCacheable`
 * passes. Non-cacheable methods pass straight through to `upstream`, and
 * on a successful (`2xx`) response every cached entry for the same URL is
 * invalidated.
 *
 * Non-cacheable *responses* (where `isCacheable` returns `false`, e.g. a
 * `404`) are returned to the caller but are never persisted: such reads
 * use `forceRefresh` so a previously-cached value is bypassed and the
 * failing response is not written back.
 */
export const handleFetch = <E>(
  cache: WriteThroughCache.WriteThroughCache,
  options: HandleFetchOptions<E>
): Effect.Effect<Response, E | StoreError> =>
  Effect.gen(function* () {
    const { request, upstream } = options;
    const method = request.method.toUpperCase();
    const cacheableMethods = (options.cacheableMethods ?? ["GET"]).map((m) => m.toUpperCase());
    const isCacheable = options.isCacheable ?? isSuccessStatus;

    if (!cacheableMethods.includes(method)) {
      // Write-through mutation: run upstream, then invalidate the URL's
      // cached representations on success.
      const response = yield* upstream(request);
      if (response.status >= 200 && response.status <= 299) {
        const url = request.url;
        yield* cache.invalidate(
          SyncKey.predicateFilter(
            (key) => key.length >= 3 && key[0] === "http-cache" && key[2] === url
          )
        );
      }
      return response;
    }

    const key = requestKey(request, { varyHeaders: options.varyHeaders });

    // The loader fetches upstream and captures the response as a
    // `CachedResponse`, carrying a flag for whether it should be persisted.
    const loader: Effect.Effect<
      { readonly cached: CachedResponse; readonly cacheable: boolean },
      E | StoreError
    > = upstream(request).pipe(
      Effect.flatMap((response) =>
        toCachedResponse(response).pipe(
          Effect.map((cached) => ({ cached, cacheable: isCacheable(cached) }))
        )
      )
    );

    // First peek: if a fresh-enough value exists, `get` returns it; if the
    // last load was non-cacheable we never stored it, so a fresh load runs.
    const result = yield* cache.get<
      { readonly cached: CachedResponse; readonly cacheable: boolean },
      E | StoreError,
      never
    >({
      key,
      loader,
      ttl: options.ttl,
      swr: options.swr,
    });

    if (!result.cacheable) {
      // The response should not be cached: remove any entry that the
      // read-through populated and return the live response.
      yield* cache.purge(key);
      return fromCachedResponse(result.cached);
    }

    return fromCachedResponse(result.cached);
  });

/**
 * A minimal runner able to execute the `handleFetch` effect as a promise.
 *
 * Both the `PromiseFacade` from core and a `ManagedRuntime` satisfy this
 * shape via their `run`/`runPromise` methods.
 */
export interface FetchRunner {
  readonly run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
}

/**
 * Promise wrapper around {@link handleFetch} for direct use inside a
 * service worker `fetch` event listener.
 *
 * ```ts
 * self.addEventListener("fetch", (event) => {
 *   event.respondWith(
 *     HttpCache.handleFetchPromise(runner, cache, {
 *       request: event.request,
 *       upstream: (req) => Effect.promise(() => fetch(req)),
 *     })
 *   );
 * });
 * ```
 */
export const handleFetchPromise = <E>(
  runner: FetchRunner,
  cache: WriteThroughCache.WriteThroughCache,
  options: HandleFetchOptions<E>
): Promise<Response> =>
  runner.run(handleFetch(cache, options) as Effect.Effect<Response, E | StoreError, never>);
