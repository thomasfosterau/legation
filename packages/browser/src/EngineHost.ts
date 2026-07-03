/**
 * EngineHost
 *
 * The host side of the tab-mirror protocol (ADR-0010): serves a running
 * ClientEngine to tab mirrors over a MirrorChannel. Mutations forward into
 * the engine's journal (optimism included — the engine's change event
 * re-broadcasts materialized rows to every tab); subset subscriptions,
 * named-query registrations, and `related` registrations are made with the
 * engine and their live results broadcast on every change.
 *
 * For `related`, the host owns the whole relational read: the reconcile
 * loop that tracks the narrowed foreign subsets AND the join itself run
 * here, and tabs receive resolved rows — data work stays off the main
 * thread (ADR-0010's goal), which is why the tab does not need the
 * collection registry.
 *
 * Registrations are refcounted by tab: an engine registration and its
 * broadcast fiber start when the first tab subscribes and stop only when
 * the last tab unsubscribes or disconnects. `Disconnect` releases
 * everything a departing tab held — the close-time signal for an orderly
 * exit.
 *
 * A tab that crashes can't send `Disconnect`, so the host also tracks each
 * tab's last-seen time (refreshed by subscribes and heartbeats) and a sweep
 * fiber reclaims registrations from tabs silent past `tabTimeout`. This is
 * the disconnect detection a BroadcastChannel can't provide on its own.
 */

import { ClientEngine, type Collection, Related, Subset } from "@legation/effect";
import { Clock, Duration, Effect, Fiber, Ref, Scope, Stream } from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

export interface EngineHostOptions {
  readonly channel: MirrorChannel;
  readonly engine: ClientEngine.ClientEngine;
  /**
   * The collection registry `related` registrations resolve against. Without
   * it, `SubscribeRelated` messages are answered with empty results and a
   * logged warning — pass it whenever tabs use relational reads.
   */
  readonly registry?: Collection.CollectionRegistry;
  /**
   * Liveness sweep: reclaim registrations from tabs not heard from within
   * `tabTimeout`, checked every `sweepInterval`. Defaults: 30s timeout,
   * 10s sweep — pair with a TabMirror heartbeat shorter than the timeout.
   */
  readonly liveness?: {
    readonly tabTimeout?: Duration.Input;
    readonly sweepInterval?: Duration.Input;
  };
}

/** One actively-broadcast registration: which tabs hold it, its fiber, teardown. */
interface Active {
  readonly tabs: ReadonlySet<string>;
  readonly fiber: Fiber.Fiber<void, never>;
  /** Engine-side release beyond interrupting the fiber (e.g. unsubscribe). */
  readonly teardown: Effect.Effect<void>;
  /** Re-hydrate a newly-joining tab from the current result. */
  readonly hydrate: Effect.Effect<void>;
}

/**
 * Serve the engine over the channel. The inbound subscription is
 * established before this effect completes; message handling runs on a
 * scoped background fiber.
 */
export const run = (options: EngineHostOptions): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { channel, engine } = options;
    const inbox = yield* channel.subscribe;
    const active = yield* Ref.make(new Map<string, Active>());
    const lastSeen = yield* Ref.make(new Map<string, number>());

    const touch = (tabId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.update(lastSeen, (map) => new Map(map).set(tabId, now)))
      );
    const forget = (tabId: string) =>
      Ref.update(lastSeen, (map) => {
        const next = new Map(map);
        next.delete(tabId);
        return next;
      });

    const broadcast = (key: string, rows: ReadonlyArray<ClientEngine.LocalRow>) =>
      channel.post(MirrorProtocol.mirrorUpdate(key, rows));
    const broadcastRelated = (key: string, rows: ReadonlyArray<Related.RelatedRow>) =>
      channel.post(MirrorProtocol.relatedUpdate(key, rows));

    /**
     * Register (or refcount) one broadcastable registration. `start` begins
     * the engine registration and returns the broadcast loop to fork; a tab
     * joining an already-active key is hydrated from the current result.
     */
    const acquire = (
      tabId: string,
      key: string,
      start: Effect.Effect<
        {
          readonly loop: Effect.Effect<void, unknown>;
          readonly teardown: Effect.Effect<void>;
          readonly hydrate: Effect.Effect<void>;
        },
        unknown
      >
    ): Effect.Effect<void, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(active)).get(key);
        if (existing !== undefined) {
          yield* Ref.update(active, (map) =>
            new Map(map).set(key, { ...existing, tabs: new Set(existing.tabs).add(tabId) })
          );
          return yield* existing.hydrate;
        }
        // A failed start (e.g. an unknown named query) registers nothing; the
        // message loop swallows the error and the tab simply never hydrates.
        const { loop, teardown, hydrate } = yield* start;
        const fiber = yield* Effect.forkScoped(loop.pipe(Effect.ignore));
        yield* Ref.update(active, (map) =>
          new Map(map).set(key, { tabs: new Set([tabId]), fiber, teardown, hydrate })
        );
      });

    /** Drop one tab from one registration; tear it down if it was the last. */
    const release = (tabId: string, key: string) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(active)).get(key);
        if (entry === undefined || !entry.tabs.has(tabId)) return;
        const tabs = new Set(entry.tabs);
        tabs.delete(tabId);
        if (tabs.size > 0) {
          yield* Ref.update(active, (map) => new Map(map).set(key, { ...entry, tabs }));
          return;
        }
        yield* Fiber.interrupt(entry.fiber);
        yield* entry.teardown.pipe(Effect.ignore);
        yield* Ref.update(active, (map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
      });

    const handleSubscribe = (tabId: string, subset: Subset.Subset) => {
      const key = Subset.hash(subset);
      return acquire(
        tabId,
        key,
        Effect.gen(function* () {
          yield* engine.subscribe(subset);
          return {
            // `observe` emits the current rows first, hydrating the subscriber.
            loop: Stream.runForEach(engine.observe(subset), (rows) => broadcast(key, rows)).pipe(
              Effect.asVoid
            ),
            teardown: engine.unsubscribe(subset).pipe(Effect.ignore),
            hydrate: engine.query(subset).pipe(
              Effect.flatMap((rows) => broadcast(key, rows)),
              Effect.ignore
            ),
          };
        })
      );
    };

    const handleSubscribeNamed = (tabId: string, name: string, args: unknown) => {
      const key = MirrorProtocol.namedKey(name, args);
      return acquire(
        tabId,
        key,
        Effect.gen(function* () {
          yield* engine.subscribeQuery(name, args);
          // Sync the registration promptly; a failed pull only delays rows
          // (the engine's own sync loop recovers).
          yield* engine.pull.pipe(Effect.ignore);
          return {
            loop: Stream.runForEach(engine.observeNamed(name, args), (rows) =>
              broadcast(key, rows)
            ).pipe(Effect.asVoid),
            teardown: engine.unsubscribeQuery(name, args).pipe(Effect.ignore),
            hydrate: engine.queryNamed(name, args).pipe(
              Effect.flatMap((rows) => broadcast(key, rows)),
              Effect.ignore
            ),
          };
        })
      );
    };

    const handleSubscribeRelated = (
      tabId: string,
      collection: string,
      subset: Subset.Subset,
      names: ReadonlyArray<string>
    ) => {
      const key = MirrorProtocol.relatedKey(collection, subset, names);
      const registry = options.registry;
      if (registry === undefined) {
        return Effect.logWarning(
          "EngineHost: SubscribeRelated received but no collection registry was configured"
        ).pipe(Effect.andThen(broadcastRelated(key, [])), Effect.ignore);
      }
      return acquire(
        tabId,
        key,
        Effect.succeed({
          // The related read is scoped (its reconcile loop holds engine
          // subscriptions): run it inside the fiber's own scope so
          // interrupting the fiber releases everything.
          loop: Effect.scoped(
            Effect.gen(function* () {
              const stream = yield* Related.related(engine, registry, collection, subset, names);
              yield* Stream.runForEach(stream, (rows) => broadcastRelated(key, rows));
            })
          ),
          teardown: Effect.void,
          hydrate: Related.query(engine, registry, collection, subset, names).pipe(
            Effect.flatMap((rows) => broadcastRelated(key, rows)),
            Effect.ignore
          ),
        })
      );
    };

    const handleDisconnect = (tabId: string) =>
      Effect.gen(function* () {
        const keys = [...(yield* Ref.get(active))]
          .filter(([, entry]) => entry.tabs.has(tabId))
          .map(([key]) => key);
        for (const key of keys) yield* release(tabId, key);
        yield* forget(tabId);
      });

    // The backend's authoritative outcome for a forwarded mutation, posted back
    // to the tab so `TabMirror.mutateWithAck` can resolve. Runs on a scoped
    // fibre because `acknowledged` only settles on a later push/pull.
    const postSettled = (requestId: number, outcome: ClientEngine.MutationOutcome) =>
      channel.post({
        _tag: "MutateSettled",
        requestId,
        outcome: outcome._tag,
        ...(outcome._tag === "rejected" ? { reason: outcome.reason } : {}),
      });

    const handleMutate = (message: MirrorProtocol.TabMessage & { readonly _tag: "Mutate" }) =>
      engine.mutateWithAck(message.mutator, message.args).pipe(
        Effect.flatMap((mutation) =>
          // Ack on journal (unchanged tab behaviour), then await the backend
          // outcome on a background fibre and forward it.
          channel
            .post({ _tag: "MutateAck", requestId: message.requestId })
            .pipe(
              Effect.andThen(
                Effect.forkScoped(
                  mutation.acknowledged.pipe(
                    Effect.flatMap((outcome) => postSettled(message.requestId, outcome))
                  )
                )
              )
            )
        ),
        Effect.catch((error) =>
          channel.post({
            _tag: "MutateError",
            requestId: message.requestId,
            message: error.message,
          })
        )
      );

    const handle = (message: MirrorProtocol.TabMessage) => {
      switch (message._tag) {
        case "Mutate":
          return handleMutate(message);
        case "Subscribe":
          return touch(message.tabId).pipe(
            Effect.andThen(handleSubscribe(message.tabId, message.subset))
          );
        case "Unsubscribe":
          return touch(message.tabId).pipe(
            Effect.andThen(release(message.tabId, Subset.hash(message.subset)))
          );
        case "SubscribeNamed":
          return touch(message.tabId).pipe(
            Effect.andThen(handleSubscribeNamed(message.tabId, message.name, message.args))
          );
        case "UnsubscribeNamed":
          return touch(message.tabId).pipe(
            Effect.andThen(
              release(message.tabId, MirrorProtocol.namedKey(message.name, message.args))
            )
          );
        case "SubscribeRelated":
          return touch(message.tabId).pipe(
            Effect.andThen(
              handleSubscribeRelated(
                message.tabId,
                message.collection,
                message.subset,
                message.names
              )
            )
          );
        case "UnsubscribeRelated":
          return touch(message.tabId).pipe(
            Effect.andThen(
              release(
                message.tabId,
                MirrorProtocol.relatedKey(message.collection, message.subset, message.names)
              )
            )
          );
        case "Disconnect":
          return handleDisconnect(message.tabId);
        case "Heartbeat":
          return touch(message.tabId);
      }
    };

    // Liveness sweep: reclaim registrations from tabs silent past the timeout.
    const tabTimeout = options.liveness?.tabTimeout ?? "30 seconds";
    const sweepInterval = options.liveness?.sweepInterval ?? "10 seconds";
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - Duration.toMillis(tabTimeout);
      const stale = [...(yield* Ref.get(lastSeen))]
        .filter(([, seen]) => seen < cutoff)
        .map(([tabId]) => tabId);
      for (const tabId of stale) yield* handleDisconnect(tabId);
    });
    yield* Effect.forkScoped(
      Effect.forever(sweep.pipe(Effect.andThen(Effect.sleep(sweepInterval))))
    );

    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeTabMessage),
          Effect.flatMap((message) =>
            message === undefined ? Effect.void : handle(message).pipe(Effect.ignore)
          )
        )
      )
    );
  });
