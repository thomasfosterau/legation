/**
 * EdgeInvalidation
 *
 * Server-side cache eviction on Cloudflare from the hints a committed write
 * publishes (#206): the `InvalidationSink`s for a Workers KV read-through cache
 * and for the Workers cache's tag purge, and the hop between the two Workers
 * that a typical deployment has.
 *
 * - {@link kv} deletes `{collection}:{id}` for every row a write touched.
 * - {@link cachePurge} purges the edge cache by tag, with the tag spelling of
 *   `HttpCache` (`collection:{name}`, `collection:{name}:{id}`), the same one
 *   the browser's Cache API invalidation uses: one convention, one place.
 * - {@link forward} and {@link receive} carry what a write touched from the
 *   Worker that commits it to the Worker that holds the cache.
 *
 * ## Where the cache is
 *
 * `cache.purge({ tags })` purges only the calling Worker's own cache. In the
 * usual two-Worker shape the cache belongs to the front door (the SvelteKit
 * Worker that serves every page), while writes land in the API Worker behind
 * a service binding (`BindingTransport`). So the API Worker runs
 * `InvalidationSink.run(EdgeInvalidation.forward(target))` where its bus is,
 * and the front door runs the sinks: its RPC entrypoint passes each payload to
 * {@link receive}. Use an RPC method on a `WorkerEntrypoint` for the target,
 * not a `fetch` route: an RPC method is reachable only through the binding,
 * while a route on the front door's `fetch` is reachable from the internet,
 * and anyone could then purge its cache.
 *
 * ## Failure
 *
 * Fire-and-forget. A failed KV delete, a failed forward and a purge that
 * rejects are logged, and so is a purge that resolves `{ success: false }`:
 * `cache.purge` reports a Cloudflare-side failure that way rather than by
 * rejecting, so a `catch` alone never sees it. None of them fails or delays
 * the write, which has already committed by the time its hint is published.
 * The cache's TTL is the backstop for a lost eviction.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpCache, type InvalidationSink } from "@thomasfosterau/legation-effect/internal";

/** The part of a Workers KV namespace binding the KV sink uses. Structural, so a test can pass a fake. */
export interface KvNamespace {
  readonly delete: (key: string) => Promise<void>;
}

/**
 * The part of the Workers cache context the purge sink uses (`ctx.cache`).
 * Structural, so a test can pass a fake.
 */
export interface CachePurger {
  readonly purge: (options: {
    tags: Array<string>;
  }) => Promise<{ readonly success: boolean; readonly errors?: ReadonlyArray<unknown> }>;
}

/** The default KV key of a row: `{collection}:{id}`. */
export const kvKey = (collection: string, id: string): string => `${collection}:${id}`;

/** Options for {@link kv}. */
export interface KvOptions {
  /** The key a row is cached under; defaults to {@link kvKey}. */
  readonly keyFor?: (collection: string, id: string) => string;
  /** How many deletes run at once. Default 8. */
  readonly concurrency?: number;
}

/**
 * A sink that deletes each touched row's entry from a KV read-through cache.
 * A failed delete is logged; the entry's TTL is the backstop.
 */
export const kv = (
  namespace: KvNamespace,
  options: KvOptions = {}
): InvalidationSink.InvalidationSink => {
  const keyFor = options.keyFor ?? kvKey;
  return {
    invalidate: (touched) =>
      Effect.forEach(
        Arr.dedupe(touched.rows.map((row) => keyFor(row.collection, row.id))),
        (key) =>
          Effect.tryPromise(() => namespace.delete(key)).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`EdgeInvalidation: KV delete of "${key}" failed`, error)
            )
          ),
        { concurrency: options.concurrency ?? 8, discard: true }
      ),
  };
};

/** Options for {@link cachePurge}. */
export interface CachePurgeOptions extends HttpCache.EvictionTagOptions {
  /**
   * The most tags one `purge` call carries; more are split across calls.
   * Default 30, a conservative bound; raise it if your plan allows more tags
   * per purge.
   */
  readonly maxTagsPerPurge?: number;
}

/**
 * A sink that purges the edge cache by tag: the coarse tag of every touched
 * collection and the fine tag of every touched row (`HttpCache.evictionTags`).
 * A purge that rejects, and one that resolves `{ success: false }`, is logged.
 */
export const cachePurge = (
  cache: CachePurger,
  options: CachePurgeOptions = {}
): InvalidationSink.InvalidationSink => {
  const size = Math.max(1, options.maxTagsPerPurge ?? 30);
  return {
    invalidate: (touched) =>
      Effect.forEach(
        Arr.chunksOf(HttpCache.evictionTags(touched, options), size),
        (tags) =>
          Effect.tryPromise(() => cache.purge({ tags: [...tags] })).pipe(
            Effect.flatMap((result) =>
              result.success
                ? Effect.void
                : Effect.logWarning(
                    "EdgeInvalidation: cache purge reported failure",
                    result.errors ?? []
                  )
            ),
            Effect.catch((error) =>
              Effect.logWarning("EdgeInvalidation: cache purge failed", error)
            )
          ),
        { concurrency: 1, discard: true }
      ),
  };
};

/**
 * The Worker that holds the cache, as the committing Worker reaches it: an RPC
 * method on the front door's `WorkerEntrypoint`, through a service binding.
 * It takes {@link encode}'s payload and passes it to {@link receive}.
 */
export interface InvalidationTarget {
  readonly invalidate: (payload: string) => Promise<void>;
}

/** The wire form of what a write touched. */
const TouchedJson = Schema.fromJsonString(
  Schema.Struct({
    collections: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Struct({ collection: Schema.String, id: Schema.String })),
  })
);

/** Encode what a write touched for {@link InvalidationTarget.invalidate}. */
export const encode = (touched: HttpCache.Touched): string =>
  Schema.encodeSync(TouchedJson)({
    collections: [...touched.collections],
    rows: touched.rows.map((row) => ({ collection: row.collection, id: row.id })),
  });

/**
 * A sink that forwards what a write touched to the Worker holding the cache.
 * A failed call is logged.
 */
export const forward = (target: InvalidationTarget): InvalidationSink.InvalidationSink => ({
  invalidate: (touched) =>
    Effect.tryPromise(() => target.invalidate(encode(touched))).pipe(
      Effect.catch((error) =>
        Effect.logWarning("EdgeInvalidation: forwarding an invalidation failed", error)
      )
    ),
});

/**
 * The receiving end of {@link forward}: decode a payload and run `sink` on it.
 * A payload that does not decode is logged and dropped. Call it from the RPC
 * method the binding reaches.
 */
export const receive =
  (sink: InvalidationSink.InvalidationSink) =>
  (payload: string): Effect.Effect<void> =>
    Option.match(Schema.decodeUnknownOption(TouchedJson)(payload), {
      onNone: () => Effect.logWarning("EdgeInvalidation: dropped a payload that does not decode"),
      onSome: (touched) => sink.invalidate(touched),
    });
