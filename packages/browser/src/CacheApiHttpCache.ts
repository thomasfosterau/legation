/**
 * CacheApiHttpCache
 *
 * The browser implementation of core's HTTP cache module (ADR-0008 narrows
 * ADR-0004's stale-marking semantics to exactly this module): a
 * ResponseCacheStore over the Cache API, plus the stale-while-revalidate
 * fetch handler service workers wire into their fetch events.
 *
 * Cache metadata (freshness window, tags) travels in a response header on
 * the stored copy, so entries are self-describing and survive across
 * service-worker restarts. Structural `CacheLike` typing keeps the module
 * testable without browser globals.
 */

import { HttpCache, StoreError, TransportError } from "@legation/effect";
import { Clock, Duration, Effect } from "effect";

/** The subset of the Cache API this store uses. */
export interface CacheLike {
  readonly match: (request: Request) => Promise<Response | undefined>;
  readonly put: (request: Request, response: Response) => Promise<void>;
  readonly delete: (request: Request) => Promise<boolean>;
  readonly keys: () => Promise<ReadonlyArray<Request>>;
}

export interface CacheStorageLike {
  readonly open: (name: string) => Promise<CacheLike>;
}

/** Header carrying the serialized CachedResponseMeta on stored copies. */
export const metaHeader = "x-legation-cache-meta";

const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

const tryCache = <A>(message: string, run: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({ try: run, catch: storeError(message) });

const readMeta = (response: Response): HttpCache.CachedResponseMeta | undefined => {
  const raw = response.headers.get(metaHeader);
  if (raw === null) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw)) as HttpCache.CachedResponseMeta;
  } catch {
    return undefined;
  }
};

/** ResponseCacheStore over one named Cache API cache. */
export const make = (cache: CacheLike): HttpCache.ResponseCacheStore => ({
  match: (request) =>
    tryCache(`Cache match failed for ${request.url}`, () => cache.match(request)).pipe(
      Effect.map((response) => {
        if (response === undefined) return undefined;
        const meta = readMeta(response);
        // Entries without our metadata are foreign; treat as a miss.
        return meta === undefined ? undefined : { response, meta };
      })
    ),
  put: (request, response, meta) =>
    tryCache(`Cache put failed for ${request.url}`, async () => {
      const headers = new Headers(response.headers);
      headers.set(metaHeader, encodeURIComponent(JSON.stringify(meta)));
      const stored = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      await cache.put(request, stored);
    }),
  delete: (request) =>
    Effect.asVoid(tryCache(`Cache delete failed for ${request.url}`, () => cache.delete(request))),
  invalidateTags: (tags) =>
    Effect.gen(function* () {
      const requests = yield* tryCache("Cache enumeration failed", () => cache.keys());
      for (const request of requests) {
        const response = yield* tryCache(`Cache match failed for ${request.url}`, () =>
          cache.match(request)
        );
        const meta = response === undefined ? undefined : readMeta(response);
        if (meta !== undefined && meta.tags.some((tag) => tags.includes(tag))) {
          yield* tryCache(`Cache delete failed for ${request.url}`, () => cache.delete(request));
        }
      }
    }),
});

/** Open a named cache (defaults to the global `caches`). */
export const open = (
  name: string,
  cacheStorage?: CacheStorageLike
): Effect.Effect<HttpCache.ResponseCacheStore, StoreError> =>
  tryCache(`Failed to open cache "${name}"`, () =>
    (cacheStorage ?? (globalThis.caches as CacheStorageLike)).open(name)
  ).pipe(Effect.map(make));

// ─── Fetch handler ───────────────────────────────────────────────────────────

export interface FetchHandlerOptions {
  readonly store: HttpCache.ResponseCacheStore;
  /** Per-request policy; `undefined` bypasses the cache entirely. */
  readonly policy: (request: Request) => HttpCache.HttpCachePolicy | undefined;
  /** The network. Defaults to the global `fetch`. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface FetchHandlerResult {
  readonly response: Response;
  /**
   * Present when a stale entry was served: refreshes the cache in the
   * background. Service workers pass it to `event.waitUntil`.
   */
  readonly revalidate?: Effect.Effect<void, StoreError | TransportError> | undefined;
}

/**
 * Build the stale-while-revalidate handler: fresh entries are served from
 * cache, stale-but-unexpired entries are served immediately with a
 * background revalidation, and expired or missing entries reload from the
 * network (caching ok GET responses).
 */
export const fetchHandler = (options: FetchHandlerOptions) => {
  const network = (request: Request) =>
    Effect.tryPromise({
      try: () => (options.fetch ?? globalThis.fetch)(request),
      catch: (cause) => new TransportError({ message: `Fetch failed for ${request.url}`, cause }),
    });

  const fetchAndStore = (
    request: Request,
    policy: HttpCache.HttpCachePolicy
  ): Effect.Effect<Response, StoreError | TransportError> =>
    Effect.gen(function* () {
      const response = yield* network(request);
      if (!response.ok) return response;
      const now = yield* Clock.currentTimeMillis;
      const timeToLive = policy.timeToLive;
      const meta: HttpCache.CachedResponseMeta = {
        url: request.url,
        storedAt: now,
        staleAt: now + Duration.toMillis(policy.staleTime),
        expiresAt: timeToLive === undefined ? undefined : now + Duration.toMillis(timeToLive),
        tags: policy.tags ?? [],
      };
      // Store a clone; hand the original back to the caller.
      yield* options.store.put(request, response.clone(), meta);
      return response;
    });

  return (request: Request): Effect.Effect<FetchHandlerResult, StoreError | TransportError> =>
    Effect.gen(function* () {
      const policy = request.method === "GET" ? options.policy(request) : undefined;
      if (policy === undefined) {
        return { response: yield* network(request), revalidate: undefined };
      }
      const cached = yield* options.store.match(request);
      const now = yield* Clock.currentTimeMillis;
      if (cached !== undefined) {
        const { meta, response } = cached;
        if (now < meta.staleAt) {
          return { response, revalidate: undefined };
        }
        if (meta.expiresAt === undefined || now < meta.expiresAt) {
          return {
            response,
            revalidate: Effect.asVoid(fetchAndStore(request, policy)),
          };
        }
      }
      return { response: yield* fetchAndStore(request, policy), revalidate: undefined };
    });
};
