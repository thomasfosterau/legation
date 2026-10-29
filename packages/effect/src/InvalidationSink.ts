/**
 * InvalidationSink
 *
 * Turn committed writes into evictions of server-side caches (#206). A
 * {@link InvalidationSink} is told what each hint batch on the
 * {@link InvalidationBus} touched, the collections and the row ids, and evicts
 * whatever it caches for them: a KV read-through cache, the edge HTTP cache's
 * tags. {@link run} subscribes a sink to the bus, so eviction stops being an
 * obligation of each mutation's call site.
 *
 * Eviction is best-effort, like the bus itself (ADR-0009): a sink logs a
 * failure and never surfaces it, and it runs on its own fibre, so it can
 * neither fail nor delay the write that published the hint. A cache's TTL is
 * the backstop for an eviction that is lost.
 *
 * The tag spelling is `HttpCache`'s convention (`collection:{name}`,
 * `collection:{name}:{id}`), shared with the browser's Cache API invalidation.
 * Runtime sinks live in their runtime's package: Cloudflare KV and
 * `cache.purge` in `@thomasfosterau/legation-cloudflare` (`EdgeInvalidation`).
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ChangeHint } from "./Backend.js";
import type { Touched } from "./HttpCache.js";
import { InvalidationBus } from "./InvalidationBus.js";

/**
 * A server-side cache that evicts what a change touched (#206). `invalidate`
 * never fails: an implementation logs its own failures, since a lost eviction
 * only leaves an entry until its TTL.
 */
export interface InvalidationSink {
  readonly invalidate: (touched: Touched) => Effect.Effect<void>;
}

/** What a hint batch touched: its collections, and every row id it names (puts and deletes). */
export const touchedBy = (hints: ReadonlyArray<ChangeHint>): Touched => ({
  collections: Arr.dedupe(hints.map((hint) => hint.collection)),
  rows: hints.flatMap((hint) => hint.ids.map((id) => ({ collection: hint.collection, id }))),
});

/** Whether a change touched nothing. */
const isEmpty = (touched: Touched): boolean =>
  Arr.isReadonlyArrayEmpty(touched.collections) && Arr.isReadonlyArrayEmpty(touched.rows);

/**
 * One sink over several, run concurrently: a KV cache and the edge cache
 * evicted from the same hint. A defect in one is logged and does not stop the
 * others.
 */
export const all = (sinks: ReadonlyArray<InvalidationSink>): InvalidationSink => ({
  invalidate: (touched) =>
    Effect.forEach(sinks, (sink) => guarded(sink, touched), {
      concurrency: "unbounded",
      discard: true,
    }),
});

/** Run one sink's eviction, logging rather than propagating a defect it did not catch. */
const guarded = (sink: InvalidationSink, touched: Touched): Effect.Effect<void> =>
  sink
    .invalidate(touched)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "InvalidationSink: an eviction failed; the cache TTL is the backstop",
          cause
        )
      )
    );

/**
 * Subscribe `sink` to the bus for the scope's lifetime: each hint batch's
 * touched collections and rows are passed to it, on a fibre of its own. Run it
 * where the bus is, in the process that commits the writes. A sink that has to
 * reach a cache in another process forwards there (Cloudflare:
 * `EdgeInvalidation.forward` over a service binding).
 */
export const run = (
  sink: InvalidationSink
): Effect.Effect<void, never, InvalidationBus | Scope.Scope> =>
  Effect.gen(function* () {
    const bus = yield* InvalidationBus;
    const subscription = yield* bus.subscribe;
    yield* Effect.forkScoped(
      Effect.forever(
        subscription.take.pipe(
          Effect.flatMap((hints) => {
            const touched = touchedBy(hints);
            return isEmpty(touched) ? Effect.void : guarded(sink, touched);
          })
        )
      )
    );
  });
