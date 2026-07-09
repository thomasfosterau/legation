/**
 * ElectedHost
 *
 * Built-in multi-tab leader election for the no-service-worker degraded
 * topology (#119): exactly one tab runs the full host (ADR-0010's
 * main-thread path — `ClientEngine` + durable store + transports +
 * `BroadcastMirrorChannel` serving), every other tab mirrors it, and a
 * dying leader's replacement resumes the SAME client identity against the
 * SAME durable store — same journal, same rows, same cookie, so the CVR
 * conversation picks up where it left off (ADR-0010).
 *
 * Election is the Web Locks API (`navigator.locks`), held for the tab's
 * whole lifetime once won — there is no voluntary step-down. A tab that
 * loses (or is still waiting) mirrors over the same `BroadcastChannel` name
 * the elected tab hosts on; when its turn comes, the browser grants the
 * lock and this module boots the host in place, so the app's `Client`
 * never needs to be rebuilt — {@link run} hands back one `Client` whose
 * underlying view swaps itself from mirror to host, and a `role` stream
 * purely for observability (devtools, a debug badge).
 *
 * Environments without `navigator.locks` (some embedded webviews) get a
 * documented fallback, not a polyfill: this module logs a warning and
 * becomes the host immediately, which is only correct for a single tab —
 * see the package README's topology section.
 */
import type { Collection, Mutation, Node, Query, Transport } from "@legation/effect";
import { Client, ClientStore, TransportError } from "@legation/effect";
import {
  ClientEngine,
  ClientView,
  EngineHost,
  Mirror,
  MirrorProtocol,
  Subset,
} from "@legation/effect/internal";
import { Effect, Exit, Layer, Ref, Scope, Stream, SubscriptionRef } from "effect";
import * as BroadcastMirrorChannel from "./BroadcastMirrorChannel.js";
import * as ServiceWorkerHost from "./ServiceWorkerHost.js";

/** Whether this tab is currently serving the engine or mirroring another tab's. */
export type Role = "host" | "mirror";

export interface ElectedHostOptions {
  /** The Web Lock name AND the sync-protocol client group — one election per group. */
  readonly clientGroupId: string;
  readonly nodes: Node.NodeRegistry;
  readonly mutations: Mutation.MutatorRegistry;
  /**
   * `ClientStore` (durable — pair {@link IndexedDbClientStore}) and
   * `ClientTransport`, composed as a Layer so winning the election is what
   * triggers connecting: nothing here opens a socket or an IndexedDB
   * transaction until this tab is actually elected, keeping a losing (or
   * still-waiting) tab's footprint to the mirror alone.
   */
  readonly dependencies: Layer.Layer<ClientStore.ClientStore | Transport.ClientTransport>;
  /**
   * The engine's client identity while this tab hosts. Defaults to
   * `host-${clientGroupId}` — deterministic and shared by construction, so
   * whichever tab wins resumes the SAME journal/rows/cookie regardless of
   * which physical tab or random id it happens to be (a fresh random id
   * per boot would fork the mutation-id sequence and orphan whatever the
   * old host had already journaled).
   */
  readonly hostClientId?: string;
  /** BroadcastChannel name shared with every tab in this group. Defaults to {@link ServiceWorkerHost.defaultChannelName}. */
  readonly channelName?: string;
  /** Forwarded to {@link EngineHost.run} for mirrors' `related` registrations. */
  readonly registry?: Collection.CollectionRegistry;
  readonly queries?: Query.QueryRegistry;
  readonly syncLoop?: ClientEngine.SyncLoopOptions;
  /** Override for tests/non-browser injection. Defaults to `navigator.locks`. */
  readonly locks?: LockManager;
}

export interface ElectedHost {
  /**
   * One stable Client for the tab's whole lifetime: reads and writes go
   * through the mirror until this tab is elected, and through the owned
   * engine from that point on — the switch is transparent to callers (a
   * live `observe`/`related` re-hydrates from the new tier; explicit
   * `subscribe` pins are replayed onto it).
   */
  readonly client: Client.Client;
  /** Purely observational — devtools/debug UI. Never drives application logic. */
  readonly role: Stream.Stream<Role>;
}

/** Resolve the ambient `navigator.locks`, `undefined` where it (or `navigator`) doesn't exist. */
const globalLocks = (): LockManager | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.locks;

/**
 * Wait to be granted `name` (Web Lock, exclusive mode), then hold it until
 * this effect's scope closes. While waiting, interruption aborts the
 * pending request (`LockManager.request`'s own `signal` option) instead of
 * leaving it queued forever.
 */
const electLeader = (locks: LockManager, name: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<() => void>((resume, signal) => {
      locks
        .request(
          name,
          { mode: "exclusive", signal },
          () =>
            new Promise<void>((resolveHeld) => {
              resume(Effect.succeed(() => resolveHeld()));
            })
        )
        .catch(() => undefined); // interrupted before ever winning: nothing to resume
    }),
    (release) => Effect.sync(release),
    { interruptible: true }
  ).pipe(Effect.asVoid);

/**
 * A `ClientView` over a `SubscriptionRef` of the currently-active view:
 * one-shot calls (`query`/`mutate`/…) always hit whatever is current;
 * `observe`/`observeNamed`/`related` re-subscribe themselves against the
 * new view the moment it changes (`Stream.switchMap`, tearing the old
 * subscription down first — a mirror's own `unsubscribe`/interrupt path);
 * explicit pins (`subscribe`/`subscribeQuery`) have no ongoing stream to
 * redo that for them, so this keeps its own ledger and replays it onto
 * every newly-active view.
 */
const switchingView = (
  viewRef: SubscriptionRef.SubscriptionRef<ClientView.ClientView>
): Effect.Effect<ClientView.ClientView, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pinnedSubsets = yield* Ref.make(new Map<string, Subset.Subset>());
    const pinnedNamed = yield* Ref.make(
      new Map<string, { readonly name: string; readonly args: unknown }>()
    );

    // Skip the CURRENT value (already active) and replay pins onto every
    // view this switches to AFTER that.
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.drop(SubscriptionRef.changes(viewRef), 1), (view) =>
        Effect.gen(function* () {
          const subsets = yield* Ref.get(pinnedSubsets);
          const named = yield* Ref.get(pinnedNamed);
          yield* Effect.forEach(
            subsets.values(),
            (subset) => view.subscribe(subset).pipe(Effect.ignore),
            {
              discard: true,
            }
          );
          yield* Effect.forEach(
            named.values(),
            (entry) => view.subscribeQuery(entry.name, entry.args).pipe(Effect.ignore),
            { discard: true }
          );
        })
      ).pipe(Effect.ignore)
    );

    const current = SubscriptionRef.get(viewRef);
    const withCurrent = <A, E>(f: (view: ClientView.ClientView) => Effect.Effect<A, E>) =>
      Effect.flatMap(current, f);

    return {
      query: (subset) => withCurrent((view) => view.query(subset)),
      observe: (subset) =>
        SubscriptionRef.changes(viewRef).pipe(Stream.switchMap((view) => view.observe(subset))),
      subscribe: (subset) =>
        Ref.update(pinnedSubsets, (map) => new Map(map).set(Subset.hash(subset), subset)).pipe(
          Effect.andThen(withCurrent((view) => view.subscribe(subset)))
        ),
      unsubscribe: (subset) =>
        Ref.update(pinnedSubsets, (map) => {
          const next = new Map(map);
          next.delete(Subset.hash(subset));
          return next;
        }).pipe(Effect.andThen(withCurrent((view) => view.unsubscribe(subset)))),
      subscribeQuery: (name, args) =>
        Ref.update(pinnedNamed, (map) =>
          new Map(map).set(MirrorProtocol.namedKey(name, args), { name, args })
        ).pipe(Effect.andThen(withCurrent((view) => view.subscribeQuery(name, args)))),
      unsubscribeQuery: (name, args) =>
        Ref.update(pinnedNamed, (map) => {
          const next = new Map(map);
          next.delete(MirrorProtocol.namedKey(name, args));
          return next;
        }).pipe(Effect.andThen(withCurrent((view) => view.unsubscribeQuery(name, args)))),
      queryNamed: (name, args) => withCurrent((view) => view.queryNamed(name, args)),
      observeNamed: (name, args) =>
        SubscriptionRef.changes(viewRef).pipe(
          Stream.switchMap((view) => view.observeNamed(name, args))
        ),
      related: (registry, collectionName, subset, edges) =>
        Effect.succeed(
          SubscriptionRef.changes(viewRef).pipe(
            Stream.switchMap((view) =>
              Stream.unwrap(view.related(registry, collectionName, subset, edges))
            )
          )
        ),
      read: (subsets) =>
        withCurrent((view) =>
          view.read === undefined
            ? Effect.fail(
                new TransportError({
                  message: "ElectedHost: no fallthrough read available on this tier",
                })
              )
            : view.read(subsets)
        ),
      mutate: (mutator, args) => withCurrent((view) => view.mutate(mutator, args)),
      mutateWithAck: (mutator, args) => withCurrent((view) => view.mutateWithAck(mutator, args)),
    };
  });

/**
 * Elect this tab into hosting `clientGroupId`'s engine — full main-thread
 * host (ADR-0010) while the lock is held, a mirror over the same channel
 * otherwise — and hand back one `Client` that works unchanged across the
 * transition, plus a `role` stream for observability.
 */
export const run = (options: ElectedHostOptions): Effect.Effect<ElectedHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const channelName = options.channelName ?? ServiceWorkerHost.defaultChannelName;
    const locks = options.locks ?? globalLocks();

    const mirrorScope = yield* Scope.make();
    const mirrorChannel = yield* BroadcastMirrorChannel.make(channelName).pipe(
      Scope.provide(mirrorScope)
    );
    const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators: options.mutations }).pipe(
      Scope.provide(mirrorScope)
    );

    const viewRef = yield* SubscriptionRef.make<ClientView.ClientView>(mirror);
    const roleRef = yield* SubscriptionRef.make<Role>("mirror");

    const becomeHost = Effect.gen(function* () {
      const hostClientId = options.hostClientId ?? `host-${options.clientGroupId}`;
      const engine = yield* ClientEngine.make({
        clientId: hostClientId,
        clientGroupId: options.clientGroupId,
        mutators: options.mutations,
        ...(options.queries === undefined ? {} : { queries: options.queries }),
        ...(options.syncLoop === undefined ? {} : { syncLoop: options.syncLoop }),
      }).pipe(Effect.provide(options.dependencies));
      const hostChannel = yield* BroadcastMirrorChannel.make(channelName);
      yield* options.registry === undefined
        ? EngineHost.run({ channel: hostChannel, engine })
        : EngineHost.run({ channel: hostChannel, engine, registry: options.registry });
      yield* Effect.forkScoped(engine.runSync.pipe(Effect.ignore));
      yield* SubscriptionRef.set(viewRef, ClientView.fromEngine(engine));
      yield* SubscriptionRef.set(roleRef, "host");
      // The mirror is no longer reachable through the switching view (and,
      // being the same tab, could never mirror its own broadcast anyway) —
      // release its heartbeat/channel rather than leave it running inert.
      yield* Scope.close(mirrorScope, Exit.void);
    });

    if (locks === undefined) {
      yield* Effect.logWarning(
        "ElectedHost: navigator.locks is unavailable — becoming host immediately. " +
          "This is only correct for a single tab; see the README's topology docs."
      );
      yield* becomeHost;
    } else {
      // A failure here (e.g. the durable store or transport failing to
      // construct) leaves this tab mirroring forever rather than crashing
      // the fiber silently — logged so it's visible, not asserted against,
      // since there's nothing more useful to do with it from here.
      yield* Effect.forkScoped(
        electLeader(locks, options.clientGroupId).pipe(
          Effect.andThen(becomeHost),
          Effect.tapCause((cause) => Effect.logError("ElectedHost: failed to become host", cause)),
          Effect.ignore
        )
      );
    }

    const view = yield* switchingView(viewRef);
    return { client: Client.fromView(options.nodes, view), role: SubscriptionRef.changes(roleRef) };
  });
