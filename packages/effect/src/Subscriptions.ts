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

import * as Defined from "./Defined.js";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ClientEngine, WindowObservation } from "./ClientEngine.js";
import type { MutatorError, QueryError, StoreError } from "./Errors.js";
import * as Json from "./internal/Json.js";
import * as Subset from "./Subset.js";

/** A held subscription. `release` is idempotent; the grace timer starts when
 * the last holder releases. */
export interface SubscriptionHandle {
  readonly release: Effect.Effect<void>;
}

/**
 * A held, reactively-retargetable window: `rows`/`retarget` are
 * {@link WindowObservation}'s (see `ClientEngine.observeWindow`); `release`
 * drops the subscription this window's *current* (possibly retargeted)
 * subset holds — unlike {@link acquire}, not refcounted, since a window's
 * subset identity (its `limit`/`cursor`) changes over its lifetime and so
 * cannot be shared under one hash-keyed entry the way a plain subset
 * subscription is. Each retargetable window should be its own observation
 * (the common case: one user's one paginated view); two independent
 * `acquireWindow` calls that happen to start from equivalently-hashed
 * subsets are not coordinated with each other.
 */
export interface WindowHandle extends WindowObservation {
  readonly release: Effect.Effect<void>;
}

/**
 * Subscription lifecycle over a `ClientEngine`: refcounted acquire/release, a grace period
 * before an unused subscription is dropped, and preload.
 */
export interface Subscriptions {
  /** Acquire a raw-subset subscription (refcounted). */
  readonly acquire: (subset: Subset.Subset) => Effect.Effect<SubscriptionHandle>;
  /**
   * Acquire a reactively-retargetable window: composes `acquire`'s
   * subscribe/release with {@link ClientEngine.observeWindow}, so `retarget`
   * widens/advances the window in place (reusing `LiveView`'s maintained
   * order) and keeps the server-synced subscription in step — the
   * `useConnection` "load more" paging hook's engine-level seam.
   */
  readonly acquireWindow: (
    subset: Subset.Subset
  ) => Effect.Effect<WindowHandle, StoreError | MutatorError, Scope.Scope>;
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

/** The engines {@link counted} built, so counting one again returns it. */
const countedEngines = new WeakSet<ClientEngine>();

/**
 * One counted voice over the engine's set-based subscription list. The
 * engine's `subscribe` / `unsubscribe` register or drop a window outright,
 * so two independent registrations of one window — an explicit pin beside
 * a relational read's own root subscription, two relational reads pinning
 * one foreign window — would drop it for both when the first released.
 * Registrations made through the returned engine hold a count per window:
 * the engine hears `subscribe` on the first hold and `unsubscribe` on the
 * last. A window this facade never counted (registered on the engine
 * directly) is released as before, so the engine's own semantics survive
 * for callers that bypass it. Everything else passes through untouched.
 *
 * Idempotent: counting a counted engine returns it, so one engine handed
 * to several fronts — an `EngineHost` and a `ClientView.fromEngine` in the
 * same tab, ADR-0010's main-thread path — has one voice, not one per front.
 */
export const counted = (engine: ClientEngine): ClientEngine => {
  if (countedEngines.has(engine)) return engine;
  const holds = MutableHashMap.empty<string, number>();
  const facade: ClientEngine = {
    ...engine,
    subscribe: (subset) =>
      Effect.suspend(() => {
        const key = Subset.hash(subset);
        const count = Option.getOrElse(MutableHashMap.get(holds, key), () => 0);
        MutableHashMap.set(holds, key, count + 1);
        return count === 0 ? engine.subscribe(subset) : Effect.void;
      }),
    unsubscribe: (subset) =>
      Effect.suspend(() => {
        const key = Subset.hash(subset);
        const count = MutableHashMap.get(holds, key);
        if (Option.isNone(count)) return engine.unsubscribe(subset);
        if (count.value > 1) {
          MutableHashMap.set(holds, key, count.value - 1);
          return Effect.void;
        }
        MutableHashMap.remove(holds, key);
        return engine.unsubscribe(subset);
      }),
  };
  countedEngines.add(facade);
  return facade;
};

interface Entry {
  count: number;
  readonly unsubscribe: Effect.Effect<void>;
}

/** Options for {@link make}. */
export interface SubscriptionsOptions {
  /** Grace period a released subscription is kept before being dropped. */
  readonly ttl?: Duration.Duration;
}

/** Build a subscription manager bound to an engine. Scoped: pending grace
 * timers are interrupted when the scope closes. */
export const make = (
  engine: ClientEngine,
  options?: SubscriptionsOptions
): Effect.Effect<Subscriptions, never, Scope.Scope> => {
  // A window's own lifecycle, deliberately NOT routed through `acquireKey`'s
  // hash-keyed `entries` map: `retarget` changes the subset's `limit`/
  // `cursor` (and so its hash) over the observation's lifetime, which the
  // refcounted map has no way to track (it would either leak the original
  // entry or, worse, silently release a DIFFERENT acquirer's subscription
  // that happens to now share the retargeted hash). `currentRef` tracks
  // this window's own current subset so `release` unsubscribes the right
  // one regardless of how many times it was retargeted.
  const acquireWindow = (
    subset: Subset.Subset
  ): Effect.Effect<WindowHandle, StoreError | MutatorError, Scope.Scope> =>
    Effect.gen(function* () {
      yield* engine.subscribe(subset);
      const currentRef = yield* Ref.make(subset);
      const observation = yield* engine.observeWindow(subset);
      const retarget: WindowHandle["retarget"] = (window) =>
        observation.retarget(window).pipe(
          Effect.andThen(
            Ref.update(currentRef, (current): Subset.Subset => ({
              ...current,
              ...Defined.fields({ limit: window.limit, cursor: window.cursor }),
            }))
          )
        );
      let released = false;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Ref.get(currentRef).pipe(Effect.flatMap((current) => engine.unsubscribe(current)));
      });
      return { rows: observation.rows, retarget, release };
    });

  return Effect.gen(function* () {
    const ttl = options?.ttl ?? Duration.minutes(5);
    const lock = yield* Semaphore.make(1);
    const entries = MutableHashMap.empty<string, Entry>();
    // The grace timer of each released entry, by key; the scope's close interrupts them.
    const expiries = yield* FiberMap.make<string, void>();
    const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Semaphore.withPermit(lock, effect);

    const dropAfterTtl = (key: string) =>
      FiberMap.run(
        expiries,
        key,
        Effect.sleep(ttl).pipe(
          Effect.andThen(
            withLock(
              Effect.gen(function* () {
                const entry = MutableHashMap.get(entries, key);
                if (Option.isSome(entry) && entry.value.count === 0) {
                  yield* entry.value.unsubscribe;
                  MutableHashMap.remove(entries, key);
                }
              })
            )
          )
        )
      );

    const releaseKey = (key: string) =>
      withLock(
        Effect.gen(function* () {
          const found = MutableHashMap.get(entries, key);
          if (Option.isNone(found) || found.value.count === 0) return;
          const entry = found.value;
          entry.count -= 1;
          if (entry.count === 0) yield* dropAfterTtl(key);
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
          const found = MutableHashMap.get(entries, key);
          if (Option.isSome(found)) {
            // A re-acquire inside the grace period cancels its expiry.
            yield* FiberMap.remove(expiries, key);
            found.value.count += 1;
          } else {
            yield* subscribe;
            MutableHashMap.set(entries, key, { count: 1, unsubscribe });
          }
        })
      ).pipe(Effect.andThen(handleFor(key)));

    const acquire = (subset: Subset.Subset) =>
      acquireKey(Subset.hash(subset), engine.subscribe(subset), engine.unsubscribe(subset));

    const acquireQuery = (name: string, args: unknown) =>
      acquireKey(
        // Strict, as `JSON.stringify` threw: a lossy key would merge two queries.
        `@query:${name}:${args === undefined ? "undefined" : Json.stringify(args)}`,
        engine.subscribeQuery(name, args),
        // Runs only after `subscribeQuery` of the same name succeeded, so the
        // name resolves and this cannot fail with an unknown-query error.
        engine.unsubscribeQuery(name, args).pipe(Effect.orDie)
      );

    return {
      acquire,
      acquireWindow,
      acquireQuery,
      preload: (subset) => Effect.asVoid(acquire(subset)),
      preloadQuery: (name, args) => Effect.asVoid(acquireQuery(name, args)),
    };
  });
};
