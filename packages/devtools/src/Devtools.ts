/**
 * Devtools
 *
 * The headless core over the introspection substrate (#120): all data
 * acquisition and every action live here as plain `Effect`/`Stream` values —
 * the same surfaces `@thomasfosterau/legation-svelte` already exposes bindings over — so a
 * framework panel (`@thomasfosterau/legation-devtools/svelte`) is a thin idiomatic UI over
 * one shared, tested read model, never its own data-acquisition path.
 *
 * Fed exclusively by already-public substrate (the `@thomasfosterau/legation/internal`
 * entrypoint, the same one `@thomasfosterau/legation-svelte` itself depends on):
 * `Introspection` (subscriptions, cookie, collections),
 * `ClientEngine.mutationStates` (#116, the journal/mutation timeline —
 * including the `"dropped"` phase paced compaction settles a compacted entry
 * to, so a devtools timeline never shows a phantom in-flight mutation),
 * `ClientEngine.engineEvents` (the sync activity log), and
 * `ClientEngine.recentSyncFailures`. Nothing here reaches into engine-private
 * state; a capability this core would need that isn't already exposed there
 * is substrate work, not a private hook.
 *
 * Two sources, one {@link DevtoolsCore} (#136): {@link make} attaches to an
 * engine + store this process owns; {@link fromMirror} attaches from a tab
 * that reaches a service-worker-hosted engine only through its `Mirror`
 * (ADR-0010/0021), over the mirror protocol's host-request envelope. Its
 * reads are core's introspection kinds (`Introspection.fromMirror`, served by
 * a host given its store) and its row counts and actions are this package's
 * own kinds ({@link requests}), which the host serves once the app passes
 * {@link hostRequests} to it. Neither reaches into `Mirror` internals: the
 * envelope is public substrate.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type {
  ClientStore,
  StoreError,
  TransportError,
  VersionNotSupportedError,
} from "@thomasfosterau/legation";
import {
  HostRequest,
  Introspection,
  Subset,
  type ClientEngine,
  type Mirror,
  type MutationState,
} from "@thomasfosterau/legation/internal";

/** One collection's name plus its confirmed row count, for the subscriptions
 * & collections panel's "rows in window" summary. */
export interface CollectionSummary {
  readonly name: string;
  readonly rowCount: number;
}

/**
 * The optional simulated-offline control (built by `Transport.simulateOffline`
 * and wired into the app's transport at boot) — the devtools actions panel's
 * offline toggle. Omitted when the app never wired a toggleable transport, in
 * which case the panel simply doesn't render that action.
 */
export interface OfflineControl {
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly isOffline: Effect.Effect<boolean>;
}

/** Options for {@link make}. */
export interface DevtoolsOptions {
  readonly offline?: OfflineControl;
}

/**
 * The devtools headless core: one instance per engine, shared by every panel
 * mounted over it. Built by {@link make} (an owned engine) or
 * {@link fromMirror} (a host engine reached through a `Mirror`), whose reads
 * and actions can also fail with a `HostRequestError`.
 */
export interface DevtoolsCore {
  // ─── Journal & mutation timeline (panel #1) ──────────────────────────────
  /** The keyed, reactive mutation-state map (#116): re-emits on every fold. */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;

  // ─── Subscriptions & collections (panel #2) ──────────────────────────────
  /** Active subsets: collection, predicate, order, and window (limit/cursor). */
  readonly subscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>, HostRequest.HostRequestError>;
  /** The current pull cookie, or `undefined` before the first pull. */
  readonly cookie: Effect.Effect<string | undefined, StoreError | HostRequest.HostRequestError>;
  /** Every collection currently holding confirmed rows, with its row count. */
  readonly collections: Effect.Effect<
    ReadonlyArray<CollectionSummary>,
    StoreError | HostRequest.HostRequestError
  >;

  // ─── Sync activity (panel #3) ────────────────────────────────────────────
  /**
   * The unified sync-lifecycle event stream (push/pull/poke/mutation/rebuild).
   * Over a mirror it re-follows the host's stream after a host restart.
   */
  readonly events: Stream.Stream<ClientEngine.EngineEvent, HostRequest.HostRequestError>;
  /**
   * The most recent terminal sync failures (retry exhausted), oldest first —
   * the "last error" surface. A point-in-time read: re-read it as `events`
   * move.
   */
  readonly syncFailures: Effect.Effect<
    ReadonlyArray<ClientEngine.SyncFailure>,
    HostRequest.HostRequestError
  >;

  // ─── Actions (panel #4) ──────────────────────────────────────────────────
  /** Push the journal now. */
  readonly forcePush: Effect.Effect<
    void,
    TransportError | StoreError | VersionNotSupportedError | HostRequest.HostRequestError
  >;
  /** Pull a patch now and rebase. */
  readonly forcePull: Effect.Effect<
    void,
    ClientEngine.SyncFailure["error"] | VersionNotSupportedError | HostRequest.HostRequestError
  >;
  /** Drop an active subscription. */
  readonly dropSubscription: (
    subset: Subset.Subset
  ) => Effect.Effect<void, HostRequest.HostRequestError>;
  /** Destructive: clear every confirmed row from the store. Gate behind a confirm in the UI. */
  readonly clearStore: Effect.Effect<void, StoreError | HostRequest.HostRequestError>;
  /** The simulated-offline toggle, if the app wired one — see {@link OfflineControl}. */
  readonly offline?: OfflineControl;
}

/** Every collection holding confirmed rows, with its row count, read off the store. */
const collectionSummaries = (
  store: ClientStore.ClientStore
): Effect.Effect<ReadonlyArray<CollectionSummary>, StoreError> =>
  store.listCollections.pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (name) =>
          store
            .listRows(name)
            .pipe(Effect.map((rows): CollectionSummary => ({ name, rowCount: rows.length }))),
        { concurrency: 1 }
      )
    )
  );

/** A core with the app's offline control, when it wired one. */
const withOffline = (
  core: Omit<DevtoolsCore, "offline">,
  options?: DevtoolsOptions
): DevtoolsCore => (options?.offline === undefined ? core : { ...core, offline: options.offline });

/** Build the devtools core over a running engine + its store. */
export const make = (
  engine: ClientEngine.ClientEngine,
  store: ClientStore.ClientStore,
  options?: DevtoolsOptions
): DevtoolsCore => {
  const introspection = Introspection.make(engine, store);
  return withOffline(
    {
      mutationStates: engine.mutationStates,
      subscriptions: introspection.subscriptions,
      cookie: introspection.cookie,
      collections: collectionSummaries(store),
      events: introspection.events,
      syncFailures: introspection.syncFailures,
      forcePush: engine.push,
      forcePull: engine.pull,
      dropSubscription: engine.unsubscribe,
      clearStore: engine.clearRows,
    },
    options
  );
};

// ─── Over the mirror seam (#136) ─────────────────────────────────────────────

const PACKAGE = "@thomasfosterau/legation-devtools";

/** The kinds {@link requests} declares, each typed by the core member it serves. */
export interface DevtoolsRequests {
  /** `collections`: every collection holding confirmed rows, with its row count. */
  readonly collections: HostRequest.Single<HostRequest.NoInput, ReadonlyArray<CollectionSummary>>;
  /** `forcePush`: push the host's journal now. */
  readonly forcePush: HostRequest.Single<HostRequest.NoInput, HostRequest.Done>;
  /** `forcePull`: pull now on the host. */
  readonly forcePull: HostRequest.Single<HostRequest.NoInput, HostRequest.Done>;
  /** `dropSubscription`: drop one of the host engine's subscriptions. */
  readonly dropSubscription: HostRequest.Single<Subset.Subset, HostRequest.Done>;
  /** `clearStore`: clear every confirmed row from the host's store. */
  readonly clearStore: HostRequest.Single<HostRequest.NoInput, HostRequest.Done>;
}

/** Wire codec for one {@link CollectionSummary}. */
const CollectionSummary = Schema.Struct({ name: Schema.String, rowCount: Schema.Finite });

/**
 * This package's host-request kinds, named under its package: the
 * collections' row counts and the four actions, which core's introspection
 * kinds do not carry. A host serves them once given {@link hostRequests}.
 */
export const requests: DevtoolsRequests = {
  collections: HostRequest.single(`${PACKAGE}/collections`, {
    request: HostRequest.NoInput,
    response: Schema.Array(CollectionSummary),
  }),
  forcePush: HostRequest.single(`${PACKAGE}/forcePush`, {
    request: HostRequest.NoInput,
    response: HostRequest.Done,
  }),
  forcePull: HostRequest.single(`${PACKAGE}/forcePull`, {
    request: HostRequest.NoInput,
    response: HostRequest.Done,
  }),
  dropSubscription: HostRequest.single(`${PACKAGE}/dropSubscription`, {
    request: Subset.Subset,
    response: HostRequest.Done,
  }),
  clearStore: HostRequest.single(`${PACKAGE}/clearStore`, {
    request: HostRequest.NoInput,
    response: HostRequest.Done,
  }),
};

const done = Effect.as({});

/**
 * The host-side handlers for {@link requests}, over the engine the host runs
 * and its store. Pass them to the host (`EngineHost.run`'s `requests`, or
 * `ServiceWorkerHost`'s), with the store, so {@link fromMirror} can attach.
 */
export const hostRequests = (
  engine: ClientEngine.ClientEngine,
  store: ClientStore.ClientStore
): ReadonlyArray<HostRequest.Handler> => [
  HostRequest.handler(requests.collections, () => collectionSummaries(store)),
  HostRequest.handler(requests.forcePush, () => done(engine.push)),
  HostRequest.handler(requests.forcePull, () => done(engine.pull)),
  HostRequest.handler(requests.dropSubscription, (subset) => done(engine.unsubscribe(subset))),
  HostRequest.handler(requests.clearStore, () => done(engine.clearRows)),
];

/** What {@link fromMirror} needs of a `Mirror`: its host requests and mirrored mutation states. */
export type MirrorSource = Pick<Mirror.Mirror, "request" | "stream" | "mutationStates">;

/**
 * Build the devtools core over the engine a mirror's host runs (#136). The
 * host serves the reads when given its store, and the row counts and actions
 * when given {@link hostRequests}; whatever it does not serve fails with a
 * `HostRequestError` of reason `UnknownKind`. `events` follows the host's
 * event stream again, a second later, after it ends with the host.
 */
export const fromMirror = (mirror: MirrorSource, options?: DevtoolsOptions): DevtoolsCore => {
  const introspection = Introspection.fromMirror(mirror);
  return withOffline(
    {
      mutationStates: mirror.mutationStates,
      subscriptions: introspection.subscriptions,
      cookie: introspection.cookie,
      collections: mirror.request(requests.collections, {}),
      events: introspection.events.pipe(Stream.retry(Schedule.spaced("1 second"))),
      syncFailures: introspection.syncFailures,
      forcePush: Effect.asVoid(mirror.request(requests.forcePush, {})),
      forcePull: Effect.asVoid(mirror.request(requests.forcePull, {})),
      dropSubscription: (subset) =>
        Effect.asVoid(mirror.request(requests.dropSubscription, subset)),
      clearStore: Effect.asVoid(mirror.request(requests.clearStore, {})),
    },
    options
  );
};
