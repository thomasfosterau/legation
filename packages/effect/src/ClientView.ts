/**
 * Client view
 *
 * The narrow surface a component binding needs — local reads (`query` /
 * `observe`), subscription registration, write intents, named queries, and
 * auto-subscribing relational reads — abstracted over *where* the engine
 * runs. A main-thread {@link ClientEngine} satisfies it via
 * {@link fromEngine}; a client context's mirror (`Mirror`,
 * whose shape this interface is drawn from) satisfies it structurally. The
 * same bindings therefore drive both hosts of ADR-0010's deployment —
 * engine-in-the-UI-context and engine-in-the-service-worker — without changing
 * component code (ADR-0021).
 *
 * `mutateWithAck` has awaited-outcome semantics (it resolves with the
 * backend's authoritative {@link MutationOutcome}), matching the mirror; the
 * engine's handle-based variant is folded by {@link fromEngine}.
 *
 * Named queries and `related` cross the mirror protocol since ADR-0021's
 * follow-up landed: a mirror forwards the registration to its host, which
 * owns the server round-trip (and, for `related`, the reconcile loop and the
 * join itself — mirrors receive resolved rows, keeping join work off the main
 * thread). Engine-only capabilities that remain (explicit push/pull, undo
 * history) still require the full engine from context.
 */
import { Context, Effect, Layer, Scope, Stream } from "effect";
import { ClientEngine, type LocalRow, type MutationOutcome } from "./ClientEngine.js";
import type * as ClientEngineModule from "./ClientEngine.js";
import type * as Collection from "./Collection.js";
import { TransportError } from "./Errors.js";
import type { MutatorError, QueryError, StoreError } from "./Errors.js";
import type * as Identity from "./Identity.js";
import type * as MutationState from "./MutationState.js";
import type { Mutation } from "./Protocol.js";
import * as Related from "./Related.js";
import type { RowChange } from "./RowChange.js";
import type * as Subset from "./Subset.js";
import * as Subscriptions from "./Subscriptions.js";

/**
 * The union of what either host may fail a view operation with: the engine
 * fails on its store/mutators/query registry, a mirror on its channel. Each
 * implementation's channels are narrower.
 */
export type ClientViewError = MutatorError | StoreError | TransportError | QueryError;

/** {@inheritDoc ClientViewError} */
export interface ClientView {
  /** Materialise a subset from the local view (confirmed + overlay). */
  readonly query: (
    subset: Subset.Subset
  ) => Effect.Effect<ReadonlyArray<LocalRow>, ClientViewError>;
  /** Live results of a subset, emitting current rows first. */
  readonly observe: (
    subset: Subset.Subset
  ) => Stream.Stream<ReadonlyArray<LocalRow>, ClientViewError>;
  /**
   * Reactive window retargeting (#133): like {@link observe}, but the
   * returned {@link ClientEngineModule.WindowObservation}'s `retarget` widens
   * or advances the SAME open observation's `limit`/`cursor` in place —
   * see {@link ClientEngineModule.ClientEngine.observeWindow}. Present only
   * for an engine-backed view (`fromEngine`): a `Mirror` has no local
   * `LiveView` of its own to retarget — a documented gap, not a silent one
   * (`docs/observing-row-changes.md`) — a mirror-backed consumer that needs
   * this re-`subscribe`s with a wider subset instead.
   */
  readonly observeWindow?: (subset: Subset.Subset) => Effect.Effect<
    {
      readonly rows: Stream.Stream<ReadonlyArray<LocalRow>, ClientViewError>;
      readonly retarget: (window: ClientEngineModule.WindowRetarget) => Effect.Effect<void>;
    },
    ClientViewError,
    Scope.Scope
  >;
  /**
   * Row-level deltas of a subset's live window (#115) — see
   * {@link ClientEngineModule.ClientEngine.observeChanges}. Satisfied
   * structurally by `Mirror` (ADR-0021's one-surface principle), which folds
   * its own page-diffing over the keyed row broadcasts it already receives.
   */
  readonly observeChanges: (
    subset: Subset.Subset,
    options?: ClientEngineModule.ObserveChangesOptions
  ) => Stream.Stream<ReadonlyArray<RowChange<LocalRow>>, ClientViewError>;
  /** Register/release a subscription (synced by the engine host). */
  readonly subscribe: (subset: Subset.Subset) => Effect.Effect<void, ClientViewError>;
  readonly unsubscribe: (subset: Subset.Subset) => Effect.Effect<void, ClientViewError>;
  /**
   * Register/release a named query (Query.ts). The engine host owns the
   * server-authoritative resolution; results render locally.
   */
  readonly subscribeQuery: (name: string, args: unknown) => Effect.Effect<void, ClientViewError>;
  readonly unsubscribeQuery: (name: string, args: unknown) => Effect.Effect<void, ClientViewError>;
  /** A named query's current local result. */
  readonly queryNamed: (
    name: string,
    args: unknown
  ) => Effect.Effect<ReadonlyArray<LocalRow>, ClientViewError>;
  /** Live named query results, emitting current rows first. */
  readonly observeNamed: (
    name: string,
    args: unknown
  ) => Stream.Stream<ReadonlyArray<LocalRow>, ClientViewError>;
  /**
   * Auto-subscribing relational read over a subset's declared relationships:
   * the host syncs the base and the narrowed foreign subsets, tracks the live
   * linkage, and tears the subscriptions down when the scope closes. The
   * stream emits resolved {@link Related.RelatedRow}s.
   */
  readonly related: (
    registry: Collection.CollectionRegistry,
    collectionName: string,
    subset: Subset.Subset,
    edges: ReadonlyArray<string | Related.EdgeSelect>
  ) => Effect.Effect<Stream.Stream<ReadonlyArray<Related.RelatedRow>, never>, never, Scope.Scope>;
  /**
   * Hold a subset's edge windows registered for the scope's lifetime
   * without resolving the join — what an explicit pin with `include` needs
   * (ADR-0029 section 2): the narrowed foreign windows keep tracking the
   * base rows, and are released when the scope closes. Over an engine this
   * is `Related.trackEdges`; a mirror registers the relational read with
   * its host and never reads the resolved rows.
   */
  readonly pinEdges: (
    registry: Collection.CollectionRegistry,
    collectionName: string,
    subset: Subset.Subset,
    edges: ReadonlyArray<string | Related.EdgeSelect>
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Point-in-time server-fallthrough read (ADR-0025): auth-filtered,
   * no CVR, results never enter the replica. Present only when the
   * underlying tier can reach a server (a transport with `read`, or a
   * host that forwards).
   */
  readonly read?: (
    subsets: ReadonlyArray<Subset.Subset>
  ) => Effect.Effect<ReadonlyArray<ClientEngineModule.ReadRow>, ClientViewError>;
  /**
   * The identity boundary (#212), present only for an engine-backed view.
   * A `Mirror` holds no durable state of its own — the replica lives in the
   * host — so resetting a connected Client is the host's Client's job, not
   * something a mirror can do on its behalf; `Client.reset` says so rather
   * than pretending to have succeeded.
   */
  readonly identityBoundary?: {
    readonly reset: (
      identity: Identity.Fingerprint
    ) => Effect.Effect<ClientEngineModule.ResetOutcome, StoreError>;
    readonly current: Effect.Effect<Identity.Fingerprint | undefined, StoreError>;
    readonly quarantines: Effect.Effect<ReadonlyArray<Identity.Fingerprint>, StoreError>;
    readonly quarantinedMutations: (
      identity: Identity.Fingerprint
    ) => Effect.Effect<ReadonlyArray<Mutation>, StoreError>;
    readonly discardQuarantine: (identity: Identity.Fingerprint) => Effect.Effect<void, StoreError>;
  };
  /** Journal a mutation and apply it optimistically; resolves on journal. */
  readonly mutate: (mutator: string, args: unknown) => Effect.Effect<void, ClientViewError>;
  /** Like {@link ClientView.mutate}, resolving with the backend's authoritative outcome. */
  readonly mutateWithAck: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<MutationOutcome, ClientViewError>;
  /**
   * The keyed mutation-state map (#116): current value now, then every fold.
   * A main-thread engine emits its own {@link ClientEngineModule.ClientEngine.mutationStates};
   * a mirror mirrors the host's — the same states either way (ADR-0021).
   */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;
}

/** The read half of a {@link ClientView} — what a local join needs. */
export type Reader = Pick<ClientView, "query" | "observe">;

/** The {@link ClientView} service: where a Client's reads and writes go, owned engine or mirror. */
export const ClientView = Context.Service<ClientView>("@thomasfosterau/legation-effect/ClientView");

/**
 * Present a {@link ClientEngine} as a {@link ClientView}. Subscriptions go
 * through one counted voice (`Subscriptions.counted`): an explicit
 * `subscribe` of a window and a `related` read's own registration of the
 * same window release independently, and the engine drops the window only
 * when the last of them lets go.
 */
export const fromEngine = (raw: ClientEngine): ClientView => {
  const engine = Subscriptions.counted(raw);
  return {
    query: (subset) => engine.query(subset),
    observe: (subset) => engine.observe(subset),
    observeWindow: (subset) => engine.observeWindow(subset),
    observeChanges: (subset, options) => engine.observeChanges(subset, options),
    subscribe: (subset) => engine.subscribe(subset),
    unsubscribe: (subset) => engine.unsubscribe(subset),
    subscribeQuery: (name, args) => engine.subscribeQuery(name, args),
    unsubscribeQuery: (name, args) => engine.unsubscribeQuery(name, args),
    queryNamed: (name, args) => engine.queryNamed(name, args),
    observeNamed: (name, args) => engine.observeNamed(name, args),
    related: (registry, collectionName, subset, edges) =>
      Related.related(engine, registry, collectionName, subset, edges),
    pinEdges: (registry, collectionName, subset, edges) =>
      Related.trackEdges(engine, registry, collectionName, subset, edges),
    ...(engine.readThrough === undefined
      ? {}
      : {
          read: (subsets: ReadonlyArray<Subset.Subset>) =>
            engine.readThrough!(subsets).pipe(
              Effect.mapError((error) =>
                error._tag === "VersionNotSupportedError"
                  ? new TransportError({ message: error.message, cause: error })
                  : error
              )
            ),
        }),
    identityBoundary: {
      reset: (identity) => engine.reset(identity),
      current: engine.identity,
      quarantines: engine.quarantines,
      quarantinedMutations: (identity) => engine.quarantinedMutations(identity),
      discardQuarantine: (identity) => engine.discardQuarantine(identity),
    },
    mutate: (mutator, args) => engine.mutate(mutator, args),
    mutateWithAck: (mutator, args) =>
      engine.mutateWithAck(mutator, args).pipe(Effect.flatMap((handle) => handle.acknowledged)),
    mutationStates: engine.mutationStates,
  };
};

/**
 * Derive the {@link ClientView} from the in-context engine. Compose with
 * `Layer.provideMerge(engineLayer)` so a runtime exposes both the view (for
 * bindings) and the engine (for engine-only capabilities).
 */
export const layer: Layer.Layer<ClientView, never, ClientEngine> = Layer.effect(ClientView)(
  Effect.map(ClientEngine, fromEngine)
);
