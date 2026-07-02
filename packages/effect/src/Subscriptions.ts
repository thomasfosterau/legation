/**
 * Subscriptions
 *
 * Subscription lifecycle on top of `ClientEngine`: reference-counted acquire /
 * release, a time-to-live grace period before an unused subscription is
 * dropped, and preload (a subscription pinned for the session). This is the
 * home for the read-side lifecycle Zero expresses as query `ttl` and
 * `preload()` — built on named queries (Query.ts) or raw subsets.
 *
 * When the last holder releases a subscription it is kept for `ttl` (default
 * 5 minutes) so a quick re-subscribe reuses the already-synced rows; if the
 * grace elapses, the engine unsubscribes and the next pull drops the rows
 * (CONTEXT.md: time to live / expiry, never "garbage collection"). Preloading
 * acquires without ever releasing.
 */

import { Duration, Effect, Fiber, Scope, Semaphore } from "effect";
import type { ClientEngine } from "./ClientEngine.js";
import type { QueryError } from "./Errors.js";
import * as Subset from "./Subset.js";

/** A held subscription. `release` is idempotent; the grace timer starts when
 * the last holder releases. */
export interface SubscriptionHandle {
  readonly release: Effect.Effect<void>;
}

export interface Subscriptions {
  /** Acquire a raw-subset subscription (refcounted). */
  readonly acquire: (subset: Subset.Subset) => Effect.Effect<SubscriptionHandle>;
  /** Acquire a named-query subscription (refcounted). */
  readonly acquireQuery: (
    name: string,
    args: unknown
  ) => Effect.Effect<SubscriptionHandle, QueryError>;
  /** Pin a subset for the session (never released). */
  readonly preload: (subset: Subset.Subset) => Effect.Effect<void>;
  /** Pin a named query for the session (never released). */
  readonly preloadQuery: (name: string, args: unknown) => Effect.Effect<void, QueryError>;
}

interface Entry {
  count: number;
  readonly unsubscribe: Effect.Effect<void>;
  expiry: Fiber.Fiber<void> | undefined;
}

export interface SubscriptionsOptions {
  /** Grace period a released subscription is kept before being dropped. */
  readonly ttl?: Duration.Duration;
}

/** Build a subscription manager bound to an engine. Scoped: pending grace
 * timers are interrupted when the scope closes. */
export const make = (
  engine: ClientEngine,
  options?: SubscriptionsOptions
): Effect.Effect<Subscriptions, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ttl = options?.ttl ?? Duration.minutes(5);
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const entries = new Map<string, Entry>();
    const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Semaphore.withPermit(lock, effect);

    const dropAfterTtl = (key: string) =>
      Effect.forkIn(
        Effect.sleep(ttl).pipe(
          Effect.andThen(
            withLock(
              Effect.gen(function* () {
                const entry = entries.get(key);
                if (entry !== undefined && entry.count === 0) {
                  yield* entry.unsubscribe;
                  entries.delete(key);
                }
              })
            )
          )
        ),
        scope
      );

    const releaseKey = (key: string) =>
      withLock(
        Effect.gen(function* () {
          const entry = entries.get(key);
          if (entry === undefined || entry.count === 0) return;
          entry.count -= 1;
          if (entry.count === 0) entry.expiry = yield* dropAfterTtl(key);
        })
      );

    const handleFor = (key: string): Effect.Effect<SubscriptionHandle> =>
      Effect.sync(() => {
        let released = false;
        return {
          release: Effect.suspend(() => {
            if (released) return Effect.void;
            released = true;
            return releaseKey(key);
          }),
        };
      });

    const acquireKey = <E>(
      key: string,
      subscribe: Effect.Effect<void, E>,
      unsubscribe: Effect.Effect<void>
    ): Effect.Effect<SubscriptionHandle, E> =>
      withLock(
        Effect.gen(function* () {
          const existing = entries.get(key);
          if (existing !== undefined) {
            if (existing.expiry !== undefined) {
              yield* Fiber.interrupt(existing.expiry);
              existing.expiry = undefined;
            }
            existing.count += 1;
          } else {
            yield* subscribe;
            entries.set(key, { count: 1, unsubscribe, expiry: undefined });
          }
        })
      ).pipe(Effect.andThen(handleFor(key)));

    const acquire = (subset: Subset.Subset) =>
      acquireKey(Subset.hash(subset), engine.subscribe(subset), engine.unsubscribe(subset));

    const acquireQuery = (name: string, args: unknown) =>
      acquireKey(
        `@query:${name}:${JSON.stringify(args)}`,
        engine.subscribeQuery(name, args),
        engine.unsubscribeQuery(name, args).pipe(Effect.orDie)
      );

    return {
      acquire,
      acquireQuery,
      preload: (subset) => Effect.asVoid(acquire(subset)),
      preloadQuery: (name, args) => Effect.asVoid(acquireQuery(name, args)),
    };
  });
