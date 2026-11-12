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
 *
 * Also on its own entry, `@thomasfosterau/legation-browser/http-cache`, which
 * reaches nothing of the engine (#678).
 */

import { StoreError, TransportError } from "@thomasfosterau/legation";
import { HttpCache } from "@thomasfosterau/legation/internal";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The subset of the Cache API this store uses. */
export interface CacheLike {
  readonly match: (request: Request) => Promise<Response | undefined>;
  readonly put: (request: Request, response: Response) => Promise<void>;
  readonly delete: (request: Request) => Promise<boolean>;
  readonly keys: () => Promise<ReadonlyArray<Request>>;
}

/** The slice of the Cache API's `CacheStorage` that {@link open} uses (`caches` in a browser). */
export interface CacheStorageLike {
  readonly open: (name: string) => Promise<CacheLike>;
}

/** Header carrying the serialized CachedResponseMeta on stored copies. */
export const metaHeader = "x-legation-cache-meta";

const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

const tryCache = <A>(message: string, run: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({ try: run, catch: storeError(message) });

/** The meta header's JSON, URI-encoded so any tag survives as a header value. */
const MetaJson = Schema.fromJsonString(HttpCache.CachedResponseMeta);

const decodeMeta = Schema.decodeUnknownOption(MetaJson);

/** Decode a stored meta header; `None` when it is absent or malformed (foreign or corrupt). */
const readMeta = (response: Response): Option.Option<HttpCache.CachedResponseMeta> =>
  Option.fromNullishOr(response.headers.get(metaHeader)).pipe(
    Option.flatMap(Option.liftThrowable(decodeURIComponent)),
    Option.flatMap(decodeMeta)
  );

const encodeMeta = (meta: HttpCache.CachedResponseMeta): Effect.Effect<string, StoreError> =>
  Schema.encodeEffect(MetaJson)(meta).pipe(
    Effect.mapError(storeError("Cache metadata failed to encode")),
    Effect.map(encodeURIComponent)
  );

/** The entry stored for the request, when it carries our metadata. */
const lookup = (
  cache: CacheLike,
  request: Request
): Effect.Effect<Option.Option<HttpCache.CachedResponse>, StoreError> =>
  tryCache(`Cache match failed for ${request.url}`, () => cache.match(request)).pipe(
    Effect.map((found) =>
      // Entries without our metadata are foreign; treat them as a miss.
      Option.fromUndefinedOr(found).pipe(
        Option.flatMap((response) => Option.map(readMeta(response), (meta) => ({ response, meta })))
      )
    )
  );

const remove = (cache: CacheLike, request: Request): Effect.Effect<void, StoreError> =>
  Effect.asVoid(tryCache(`Cache delete failed for ${request.url}`, () => cache.delete(request)));

/** ResponseCacheStore over one named Cache API cache. */
export const make = (cache: CacheLike): HttpCache.ResponseCacheStore => ({
  match: (request) => lookup(cache, request),
  put: Effect.fnUntraced(function* (request, response, meta) {
    const headers = new Headers(response.headers);
    headers.set(metaHeader, yield* encodeMeta(meta));
    const stored = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    yield* tryCache(`Cache put failed for ${request.url}`, () => cache.put(request, stored));
  }),
  delete: (request) => remove(cache, request),
  invalidateTags: Effect.fnUntraced(function* (tags) {
    const requests = yield* tryCache("Cache enumeration failed", () => cache.keys());
    const tagged = (meta: HttpCache.CachedResponseMeta) =>
      Arr.some(meta.tags, (tag) => Arr.contains(tags, tag));
    yield* Effect.forEach(
      requests,
      (request) =>
        lookup(cache, request).pipe(
          Effect.flatMap((hit) =>
            Option.exists(hit, ({ meta }) => tagged(meta)) ? remove(cache, request) : Effect.void
          )
        ),
      { concurrency: 1, discard: true }
    );
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

/** Options for {@link fetchHandler}. */
export interface FetchHandlerOptions {
  readonly store: HttpCache.ResponseCacheStore;
  /** Per-request policy; `None` bypasses the cache entirely. */
  readonly policy: (request: Request) => Option.Option<HttpCache.HttpCachePolicy>;
  /** The network. Defaults to the global `fetch`. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** What {@link fetchHandler} answers a request with. */
export interface FetchHandlerResult {
  readonly response: Response;
  /**
   * `Some` when a stale entry was served: refreshes the cache in the
   * background. Service workers pass it to `event.waitUntil`.
   */
  readonly revalidate: Option.Option<Effect.Effect<void, StoreError | TransportError>>;
}

/** A request handler built by {@link fetchHandler}. */
export type FetchHandler = (
  request: Request
) => Effect.Effect<FetchHandlerResult, StoreError | TransportError>;

/**
 * Whether a response's `Cache-Control` carries the `public` directive: an
 * {@link HttpCache.HttpCachePolicy} `cacheable` predicate, together with
 * `response.ok`, for routes cached only when the origin marks them public.
 */
export const isPublic = (response: Response): boolean =>
  Option.fromNullishOr(response.headers.get("cache-control")).pipe(
    Option.exists((header) =>
      Arr.some(header.split(","), (directive) => directive.trim().toLowerCase() === "public")
    )
  );

const defaultCacheable = (response: Response): boolean => response.ok;

/**
 * Build the stale-while-revalidate handler: fresh entries are served from
 * cache, stale-but-unexpired entries are served immediately with a
 * background revalidation, and expired or missing entries reload from the
 * network (storing GET responses the policy's `cacheable` accepts, by
 * default the ok ones).
 */
export const fetchHandler = (options: FetchHandlerOptions): FetchHandler => {
  const network = (request: Request) =>
    Effect.tryPromise({
      try: () => (options.fetch ?? globalThis.fetch)(request),
      catch: (cause) => new TransportError({ message: `Fetch failed for ${request.url}`, cause }),
    });

  const fetchAndStore = Effect.fnUntraced(function* (
    request: Request,
    policy: HttpCache.HttpCachePolicy
  ) {
    const response = yield* network(request);
    if (!(policy.cacheable ?? defaultCacheable)(response)) return response;
    const now = yield* Clock.currentTimeMillis;
    const meta: HttpCache.CachedResponseMeta = {
      url: request.url,
      storedAt: now,
      staleAt: now + Duration.toMillis(policy.staleTime),
      expiresAt:
        policy.timeToLive === undefined ? undefined : now + Duration.toMillis(policy.timeToLive),
      tags: policy.tags ?? [],
    };
    // Store a clone; hand the original back to the caller.
    yield* options.store.put(request, response.clone(), meta);
    return response;
  });

  const fromNetwork = (request: Request, policy: HttpCache.HttpCachePolicy) =>
    Effect.map(fetchAndStore(request, policy), (response) => ({
      response,
      revalidate: Option.none(),
    }));

  const cached = Effect.fnUntraced(function* (request: Request, policy: HttpCache.HttpCachePolicy) {
    const hit = yield* options.store.match(request);
    const now = yield* Clock.currentTimeMillis;
    if (Option.isNone(hit)) return yield* fromNetwork(request, policy);
    const { meta, response } = hit.value;
    if (now < meta.staleAt) return { response, revalidate: Option.none() };
    if (meta.expiresAt === undefined || now < meta.expiresAt) {
      return { response, revalidate: Option.some(Effect.asVoid(fetchAndStore(request, policy))) };
    }
    return yield* fromNetwork(request, policy);
  });

  return (request) =>
    Option.match(request.method === "GET" ? options.policy(request) : Option.none(), {
      onNone: () =>
        Effect.map(network(request), (response) => ({ response, revalidate: Option.none() })),
      onSome: (policy) => cached(request, policy),
    });
};
