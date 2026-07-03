/**
 * ClientEngine
 *
 * The client-side engine: optimistic mutations into the journal, local
 * materialization (confirmed rows + optimistic overlay), subscriptions,
 * and the sync loop (push journal, pull patches, rebase).
 *
 * Rebase is recomputation (ADR-0008): the materialized view is always
 * "confirmed rows with pending mutations replayed on top", so applying a
 * patch and dropping acknowledged mutations IS the rebase — revealed
 * atomically through a single changes event.
 */

import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Metric,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as Aggregate from "./Aggregate.js";
import type { RowId, RowVersion } from "./Collection.js";
import { ClientStore } from "./ClientStore.js";
import * as Hash from "./Hash.js";
import {
  MutatorError,
  QueryError,
  StoreError,
  TransportError,
  VersionNotSupportedError,
} from "./Errors.js";
import * as LiveView from "./LiveView.js";
import type { LocalWriter, MutatorRegistry } from "./Mutator.js";
import type {
  Mutation,
  NamedSubscription,
  PatchOp,
  PullResponse,
  PushResponse,
  ReadResponse,
} from "./Protocol.js";
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
import { ClientTransport } from "./Transport.js";
import * as Subset from "./Subset.js";

/** A locally-materialized row (no version: overlay rows have none yet). */
export interface LocalRow {
  readonly id: RowId;
  readonly value: unknown;
}

/**
 * A {@link LocalRow} whose `value` is refined to the collection's row type `A`.
 * Produced by the typed `query`/`observe` overloads when handed a
 * {@link Subset.TypedSubset}. The refinement is a trust-cast: server data
 * already passed the row schema on write, so the read path never decodes
 * (ADR-0014) — only the static type is narrowed.
 */
export interface TypedRow<A> {
  readonly id: RowId;
  readonly value: A;
}

/**
 * Options for a projected {@link ClientEngine.observe}: `select` maps each
 * emitted page to a derived value `B`; consecutive equal projections are
 * dropped by `equals` (reference equality by default), so a change to a field
 * the projection ignores never re-emits.
 */
export interface ObserveOptions<Row, B> {
  readonly select: (rows: ReadonlyArray<Row>) => B;
  readonly equals?: (a: B, b: B) => boolean;
}

/**
 * A mutation's authoritative (server) outcome: `applied` once the backend
 * acknowledged it with effects, or `rejected` with a reason when the backend
 * permanently refused it (#35). Observed via {@link MutationHandle}.
 */
export type MutationOutcome =
  | { readonly _tag: "applied" }
  | { readonly _tag: "rejected"; readonly reason: string };

/**
 * A handle to a journaled mutation whose backend outcome can be awaited. The
 * `acknowledged` effect resolves once the backend settles the mutation (via a
 * push or pull acknowledgement); it is interrupted if the engine scope closes
 * first, so it never hangs.
 */
export interface MutationHandle {
  readonly mutationId: number;
  readonly acknowledged: Effect.Effect<MutationOutcome>;
}

/**
 * A mutation lifecycle event on {@link ClientEngine.mutationEvents}: emitted
 * when a mutation is `journaled` locally, then when the backend `acknowledged`
 * (applied) or `rejected` it. Every journaled mutation emits `journaled`,
 * whether it came from `mutate`, `mutateEncoded`, or `mutateWithAck`.
 */
export interface MutationEvent {
  readonly clientId: string;
  readonly mutationId: number;
  readonly phase: "journaled" | "acknowledged" | "rejected";
  readonly reason?: string;
}

/**
 * A unified sync-lifecycle event on {@link ClientEngine.engineEvents} (#45):
 * the single source of truth from which {@link ClientEngine.mutationEvents}
 * (#36) is derived. Every variant is emitted from one internal hub, kept
 * unbounded for the same reason #44 keeps `mutationEventsHub` unbounded:
 * lifecycle events are low-volume, consumer-driven, and must be lossless —
 * they are observability, not reconstructable via pull.
 *
 * - `MutationJournaled` — a mutation was journaled locally (from `mutate`,
 *   `mutateEncoded`, or `mutateWithAck`).
 * - `MutationAcknowledged` — the backend applied a journaled mutation.
 * - `MutationRejected` — the backend permanently refused it, with a `reason`.
 * - `PushStarted` / `PushCompleted` — a push began / finished (with the number
 *   of `mutations` delivered).
 * - `PullStarted` / `PullCompleted` — a pull began / finished (with the number
 *   of patch `ops` applied and the distinct `collections` those ops touched —
 *   a `Clear` stands for every collection the client currently holds, since it
 *   resets the whole view). The touched collections drive collection-scoped
 *   reactions such as HTTP-cache tag invalidation (`@legation/browser`), which
 *   is why they are reported even on a client with an empty journal (the
 *   common case, where a pull emits a `Patch` change and no `ViewRebuilt`).
 * - `PokeReceived` — the sync loop observed a poke (with its optional `reason`).
 * - `ViewRebuilt` — the local view was rebuilt (rebase/seed/subscribe), scoped
 *   to the `collections` the shift touched (absent means "any collection").
 * - `UpdateNeeded` — the server rejected this build's `schemaVersion` (#48);
 *   emitted at most once per ongoing rejection (the latch resets on the next
 *   successful push/pull), alongside the `onUpdateNeeded` hook.
 */
export type EngineEvent =
  | { readonly _tag: "MutationJournaled"; readonly clientId: string; readonly mutationId: number }
  | {
      readonly _tag: "MutationAcknowledged";
      readonly clientId: string;
      readonly mutationId: number;
    }
  | {
      readonly _tag: "MutationRejected";
      readonly clientId: string;
      readonly mutationId: number;
      readonly reason: string;
    }
  | { readonly _tag: "PushStarted" }
  | { readonly _tag: "PushCompleted"; readonly mutations: number }
  | { readonly _tag: "PullStarted" }
  | {
      readonly _tag: "PullCompleted";
      readonly ops: number;
      readonly collections: ReadonlyArray<string>;
    }
  | { readonly _tag: "PokeReceived"; readonly reason?: string }
  | { readonly _tag: "ViewRebuilt"; readonly collections?: ReadonlyArray<string> }
  | {
      readonly _tag: "UpdateNeeded";
      readonly schemaVersion?: string;
      readonly message: string;
    };

/**
 * A local-view change. `Patch` carries per-row confirmed deltas (emitted only
 * when the journal is empty, so they equal the materialized-view deltas) and
 * drives incremental `LiveView` maintenance. `Rebuild` is the conservative
 * fallback when the optimistic overlay shifts, so observers re-materialize; its
 * `collections` names exactly which collections the shift touched, so an
 * observer of a collection outside the set skips the recompute. `collections`
 * left `undefined` means "any collection" — the global fallback for changes we
 * cannot scope precisely (a `Clear`, an unknown mutator, a pull with pending).
 */
type ViewChange =
  | { readonly _tag: "Patch"; readonly ops: ReadonlyArray<PatchOp> }
  | { readonly _tag: "Rebuild"; readonly collections?: ReadonlySet<string> };

/** The global rebuild: `collections` undefined, so every observer re-materializes. */
const REBUILD: ViewChange = { _tag: "Rebuild" };

/** A rebuild scoped to `collections`, or the global {@link REBUILD} when undefined. */
const rebuildFor = (collections: ReadonlySet<string> | undefined): ViewChange =>
  collections === undefined ? REBUILD : { _tag: "Rebuild", collections };

/**
 * Sync-loop scheduling knobs. `push`/`pull` stay the primitives; these grow
 * `runSync` into a configurable scheduler driven by `Effect.Schedule` and the
 * transport's `statusChanges` seam. Both are opt-in: unset means the loop
 * keeps only its baseline triggers (pull on poke, push+pull on reconnect).
 * Retry/backoff is a separate concern the loop composes with, not embeds.
 */
export interface SyncLoopOptions {
  /**
   * Auto-push after `mutate`/`mutateEncoded` journals a mutation, debounced so
   * a burst of mutations inside the window coalesces into a single push (the
   * journal already batches naturally).
   */
  readonly pushDebounce?: Duration.Input;
  /**
   * Periodic pull as the correctness backstop, so the client converges over
   * pull alone even when no pokes arrive ("pull is the correctness path").
   */
  readonly pullInterval?: Duration.Input;
}

/**
 * Retry/backoff policies for the sync loop's network legs (#34). The scheduler
 * (#33) decides *when* to attempt; these `Schedule`s decide *how* an attempt
 * survives transient failure — kept orthogonal to avoid double-retry. Only
 * `TransportError` is retried; `StoreError`/`MutatorError` are not transient and
 * propagate to the failure surface immediately. Unset legs use
 * {@link defaultRetryPolicy}.
 */
export interface RetryOptions {
  readonly push?: Schedule.Schedule<unknown, unknown>;
  readonly pull?: Schedule.Schedule<unknown, unknown>;
  /** Re-establishment policy for a failed poke stream. */
  readonly pokes?: Schedule.Schedule<unknown, unknown>;
}

/**
 * Default backoff: exponential from 1s (factor 2), the delay capped at 30s,
 * bounded to 5 retries — mirroring TanStack Query's 1s→30s policy. No jitter,
 * so it composes predictably; add `Schedule.jittered` to taste.
 */
export const defaultRetryPolicy: Schedule.Schedule<unknown, unknown> = Schedule.exponential(
  Duration.seconds(1),
  2
).pipe(Schedule.either(Schedule.spaced(Duration.seconds(30))), Schedule.both(Schedule.recurs(5)));

/** A terminal sync failure surfaced after the retry policy was exhausted. */
export interface SyncFailure {
  readonly operation: "push" | "pull" | "pokes";
  readonly error: TransportError | StoreError | MutatorError;
}

export interface ClientEngineOptions {
  readonly clientId: string;
  readonly clientGroupId: string;
  readonly mutators: MutatorRegistry;
  /** Named queries: client-side subset factories for local rendering. */
  readonly queries?: Query.QueryRegistry;
  /** Sync-loop scheduling (push-on-mutate debounce, interval pull). */
  readonly syncLoop?: SyncLoopOptions;
  /** Retry/backoff policies for push, pull, and the poke stream. */
  readonly retry?: RetryOptions;
  /**
   * Capacity of the bounded change hub (#44). A stalled observer cannot make
   * the hub grow without limit: at capacity the hub drops the newest
   * view-changes, and the consumer collapses the resulting seq gap into a
   * lossless `Rebuild` (see {@link make}). Defaults to
   * {@link DEFAULT_CHANGE_HUB_CAPACITY}.
   */
  readonly changeHubCapacity?: number;
  /**
   * This build's schema version (#48), sent on every push and pull request. The
   * server's acceptor may reject an unsupported version; omit it for today's
   * version-less behaviour.
   */
  readonly schemaVersion?: string;
  /**
   * Invoked when the server rejects this build's `schemaVersion`
   * (`VersionNotSupportedError`) — the app's cue to prompt an update. Fired
   * **exactly once per occurrence**: a latch dedupes a retry storm / repeated
   * pulls so an ongoing rejection refires it only after the next request
   * succeeds. The pending journal is retained across the rejection (a version
   * rejection is a transport-level "your build is obsolete", not a per-mutation
   * verdict), so intents survive an eventual update. Also emitted as an
   * `UpdateNeeded` engine event.
   */
  readonly onUpdateNeeded?: (info: {
    readonly schemaVersion?: string;
    readonly message: string;
  }) => Effect.Effect<void>;
}

/**
 * Default bound for the change hub. Large enough that no realistic burst of
 * mutations/pulls fills it under normal consumption, so behaviour is identical
 * to the old unbounded hub until an observer genuinely stalls.
 */
const DEFAULT_CHANGE_HUB_CAPACITY = 1024;

/**
 * A {@link ViewChange} tagged with a monotonic sequence number. The consumer
 * tracks the last seq it saw; a non-contiguous seq means the bounded hub
 * dropped one or more changes, which it collapses into a full `Rebuild`.
 */
interface SeqChange {
  readonly seq: number;
  readonly change: ViewChange;
}

/** One row of a fallthrough read (ADR-0025). */
export type ReadRow = ReadResponse["rows"][number];

export interface ClientEngine {
  /**
   * Run a mutator optimistically and journal it for push. Args are
   * validated against the mutator's schema and journaled in encoded
   * (wire/persistence) form; handlers always receive decoded args.
   */
  readonly mutate: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | StoreError>;
  /**
   * Run a mutator whose args are already in encoded (wire) form — the
   * entry point for remote surfaces (mirrors, devtools) forwarding
   * mutations over a carrier. Args are validated by decoding.
   */
  readonly mutateEncoded: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | StoreError>;
  /**
   * Like {@link mutate}, but returns a {@link MutationHandle} whose
   * `acknowledged` effect resolves with the mutation's authoritative outcome
   * (applied or permanently rejected). Validates and journals identically to
   * `mutate`; the returned handle lets a caller await the backend's verdict.
   */
  readonly mutateWithAck: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<MutationHandle, MutatorError | StoreError>;
  /**
   * Mutation lifecycle events: a `journaled` event for every journaled
   * mutation, then `acknowledged` or `rejected` once the backend settles it.
   */
  readonly mutationEvents: Stream.Stream<MutationEvent>;
  /**
   * The unified sync-lifecycle event stream (#45): mutation, push, pull, poke,
   * and view-rebuild events from one hub. {@link mutationEvents} is a filtered
   * projection of this stream. Consumed read-only by `EngineIntrospection`.
   */
  readonly engineEvents: Stream.Stream<EngineEvent>;
  /**
   * A read-only snapshot of the engine's active subsets — the raw subscriptions
   * plus every named subscription resolved through its local subset factory.
   * The introspection seam (`Introspection.ts`); does not touch private state
   * from outside.
   */
  readonly activeSubscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>>;
  /** Register/replace the engine's subscriptions (synced on next pull). */
  readonly subscribe: (subset: Subset.Subset) => Effect.Effect<void>;
  readonly unsubscribe: (subset: Subset.Subset) => Effect.Effect<void>;
  /**
   * Seed the local view with confirmed rows before any transport call, so
   * observers render them synchronously (the hydration path — pair with
   * `Hydration.hydrate` for a full store, or use `seed` for a targeted warm-up).
   * Writes the rows via the store and publishes one change scoped to exactly the
   * seeded collections.
   *
   * The `version`s must be genuine backend versions for CVR diffing to converge
   * cheaply on the next pull; self-invented versions are safe but degrade to the
   * reset path (the server sends a `Clear` + full puts). See `Hydration.ts`.
   */
  readonly seed: (
    rows: ReadonlyArray<{
      readonly collection: string;
      readonly id: RowId;
      readonly version: RowVersion;
      readonly value: unknown;
    }>
  ) => Effect.Effect<void, StoreError>;
  /**
   * Prefetch a subset: `subscribe` to it, and if it currently yields no local
   * rows, `pull` once so the rows are present before the caller proceeds.
   * Concurrent calls for the same subset dedupe — at most one pull runs per
   * `Subset.hash` in flight — so a burst of renders that all need the same data
   * triggers a single network round-trip.
   */
  readonly ensureSubset: (
    subset: Subset.Subset
  ) => Effect.Effect<void, TransportError | StoreError | MutatorError | VersionNotSupportedError>;
  /**
   * Subscribe a named query (Query.ts): the server resolves it to the
   * authoritative subset it syncs; the client renders it locally with its own
   * subset factory. Synced on the next pull.
   */
  readonly subscribeQuery: (name: string, args: unknown) => Effect.Effect<void, QueryError>;
  readonly unsubscribeQuery: (name: string, args: unknown) => Effect.Effect<void, QueryError>;
  /** Query a named query's local result (confirmed + overlay). */
  readonly queryNamed: (
    name: string,
    args: unknown
  ) => Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError | QueryError>;
  /** Live named query: re-emits on every local change. */
  readonly observeNamed: (
    name: string,
    args: unknown
  ) => Stream.Stream<ReadonlyArray<LocalRow>, StoreError | MutatorError | QueryError>;
  /**
   * Query the current local view (confirmed + overlay). A
   * {@link Subset.TypedSubset} refines the rows to its row type; a plain
   * `Subset` keeps returning untyped {@link LocalRow}s.
   */
  readonly query: {
    <A>(
      subset: Subset.TypedSubset<A>
    ): Effect.Effect<ReadonlyArray<TypedRow<A>>, StoreError | MutatorError>;
    (subset: Subset.Subset): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError>;
  };
  /**
   * Live query: emits the result now and after every local change. With a
   * {@link ObserveOptions.select} it emits the projection instead, re-emitting
   * only when the projected value changes. A {@link Subset.TypedSubset} refines
   * the row type; a plain `Subset` keeps returning untyped {@link LocalRow}s.
   */
  readonly observe: {
    <A, B>(
      subset: Subset.TypedSubset<A>,
      options: ObserveOptions<TypedRow<A>, B>
    ): Stream.Stream<B, StoreError | MutatorError>;
    <B>(
      subset: Subset.Subset,
      options: ObserveOptions<LocalRow, B>
    ): Stream.Stream<B, StoreError | MutatorError>;
    <A>(
      subset: Subset.TypedSubset<A>
    ): Stream.Stream<ReadonlyArray<TypedRow<A>>, StoreError | MutatorError>;
    (subset: Subset.Subset): Stream.Stream<ReadonlyArray<LocalRow>, StoreError | MutatorError>;
  };
  /**
   * One-shot aggregate over the current local view (confirmed + overlay):
   * `query` the subset, then fold it with {@link Aggregate.compute}.
   *
   * Local tier only — the aggregate sees exactly the rows this client has
   * synced (a subset's window included); a server-evaluated tier that folds
   * the whole collection is explicit future work.
   */
  readonly queryAggregate: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate
  ) => Effect.Effect<Aggregate.AggregateValue, StoreError | MutatorError>;
  /** One-shot grouped aggregate over the current local view (see {@link queryAggregate}). */
  readonly queryAggregateGrouped: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate,
    groupBy: string
  ) => Effect.Effect<Record<string, Aggregate.AggregateValue>, StoreError | MutatorError>;
  /**
   * Live aggregate over a subset: emits now and after every local change,
   * re-scanning the subset and folding it. Deduped — a change that leaves the
   * aggregate value unchanged does not re-emit. Local tier only, as
   * {@link queryAggregate}.
   */
  readonly observeAggregate: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate
  ) => Stream.Stream<Aggregate.AggregateValue, StoreError | MutatorError>;
  /** Live grouped aggregate; deduped by structural equality of the record (see {@link observeAggregate}). */
  readonly observeAggregateGrouped: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate,
    groupBy: string
  ) => Stream.Stream<Record<string, Aggregate.AggregateValue>, StoreError | MutatorError>;
  /**
   * Push pending mutations now. Fails with `VersionNotSupportedError` when the
   * server rejects this build's `schemaVersion` (#48) — the journal is retained,
   * and `onUpdateNeeded` fires (deduped) as a side effect.
   */
  readonly push: Effect.Effect<void, TransportError | StoreError | VersionNotSupportedError>;
  /**
   * Pull a patch now and rebase. Fails with `VersionNotSupportedError` when the
   * server rejects this build's `schemaVersion` (#48); see {@link push}.
   */
  readonly pull: Effect.Effect<
    void,
    TransportError | StoreError | MutatorError | VersionNotSupportedError
  >;
  /**
   * Point-in-time fallthrough read over the transport (ADR-0025): the
   * server evaluates the subsets under its auth filters, with no CVR
   * involvement; results are returned to the caller and **never** written
   * to the local store. Present only when the transport offers `read`.
   */
  readonly readThrough?: (
    subsets: ReadonlyArray<Subset.Subset>
  ) => Effect.Effect<ReadonlyArray<ReadRow>, TransportError | VersionNotSupportedError>;
  /** Run the sync loop: pull on poke; push+pull on reconnect. */
  readonly runSync: Effect.Effect<void, TransportError | StoreError | MutatorError, Scope.Scope>;
  /**
   * Terminal sync failures surfaced after the retry policy is exhausted — so
   * bindings can show a "sync degraded" state. Also counted in
   * `Telemetry.syncFailuresTotal`.
   */
  readonly syncFailures: Stream.Stream<SyncFailure>;
}

export const ClientEngine = Context.Service<ClientEngine>("@legation/effect/ClientEngine");

export const make = (
  options: ClientEngineOptions
): Effect.Effect<ClientEngine, never, ClientStore | ClientTransport | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* ClientStore;
    const transport = yield* ClientTransport;
    const subscriptions = yield* Ref.make<ReadonlyArray<Subset.Subset>>([]);
    // In-flight `ensureSubset` pulls, keyed by `Subset.hash`, so concurrent
    // prefetches of the same subset share one pull instead of racing N of them.
    const ensurePulls = yield* Ref.make(
      new Map<
        string,
        Deferred.Deferred<
          void,
          TransportError | StoreError | MutatorError | VersionNotSupportedError
        >
      >()
    );
    const namedSubs = yield* Ref.make<
      ReadonlyArray<{ readonly name: string; readonly argsEncoded: unknown; readonly key: string }>
    >([]);
    // Bounded, dropping change hub (#44). A stalled observer holds messages in
    // the shared hub; at capacity the hub drops the newest `SeqChange`s rather
    // than growing without limit. Each change carries a monotonic `seq`, so a
    // consumer detects a drop as a seq gap and collapses it into a `Rebuild`
    // that subsumes the dropped `Patch`es — lossless under pressure, identical
    // to the old hub under none (contiguous seqs → same incremental path).
    const changes = yield* Effect.acquireRelease(
      PubSub.dropping<SeqChange>({
        capacity: options.changeHubCapacity ?? DEFAULT_CHANGE_HUB_CAPACITY,
      }),
      (hub) => PubSub.shutdown(hub)
    );
    // Monotonic sequence stamped on every published change. The store mutation
    // a change describes always completes before its seq is assigned here, so
    // "seqRef == R" implies the store reflects every change with seq ≤ R — the
    // invariant the consumer's gap-collapse relies on to skip stale buffered
    // changes after a Rebuild.
    const changeSeq = yield* Ref.make(0);
    // The single unified event hub (#45): every sync-lifecycle event flows
    // through here, and `mutationEvents` (#36) is a filtered projection of it.
    // Unbounded for the same reason #44 kept `mutationEventsHub` unbounded —
    // lifecycle events are low-volume, consumer-driven, and lossless (they are
    // observability, not reconstructable via pull).
    const engineEventsHub = yield* Effect.acquireRelease(PubSub.unbounded<EngineEvent>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const emitEngineEvent = (event: EngineEvent): Effect.Effect<void> =>
      Effect.asVoid(PubSub.publish(engineEventsHub, event));
    // A Rebuild change is a view rebuild; carry its scoped collections (#39).
    const viewRebuiltEvent = (change: ViewChange): Effect.Effect<void> =>
      change._tag === "Rebuild"
        ? emitEngineEvent({
            _tag: "ViewRebuilt",
            ...(change.collections !== undefined ? { collections: [...change.collections] } : {}),
          })
        : Effect.void;
    const publishChange = (change: ViewChange): Effect.Effect<void> =>
      Ref.updateAndGet(changeSeq, (n) => n + 1).pipe(
        Effect.flatMap((seq) => PubSub.publish(changes, { seq, change })),
        Effect.andThen(viewRebuiltEvent(change)),
        Effect.asVoid
      );

    // Fires whenever a mutation is journaled; the sync loop debounces it into
    // an auto-push when `syncLoop.pushDebounce` is set.
    const pushTrigger = yield* Effect.acquireRelease(PubSub.unbounded<void>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const signalPush = Effect.asVoid(PubSub.publish(pushTrigger, undefined));

    // Terminal sync failures (retry exhausted) surfaced to bindings + metrics.
    const failures = yield* Effect.acquireRelease(PubSub.unbounded<SyncFailure>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const surfaceFailure = (
      operation: SyncFailure["operation"],
      error: SyncFailure["error"]
    ): Effect.Effect<void> =>
      Metric.update(Telemetry.syncFailuresTotal, 1).pipe(
        Effect.andThen(PubSub.publish(failures, { operation, error })),
        Effect.asVoid
      );

    // Per-mutation outcome deferreds registered by `mutateWithAck`, keyed by
    // mutation id. `mutate`/`mutateEncoded` never register one, so their path
    // stays allocation-free.
    const acks = yield* Ref.make(new Map<number, Deferred.Deferred<MutationOutcome>>());
    // Emit a mutation-lifecycle event onto the unified hub as its tagged
    // variant; `mutationEvents` projects these three tags back to `phase`s.
    const emitEvent = (
      mutationId: number,
      phase: MutationEvent["phase"],
      reason?: string
    ): Effect.Effect<void> => {
      const clientId = options.clientId;
      switch (phase) {
        case "journaled":
          return emitEngineEvent({ _tag: "MutationJournaled", clientId, mutationId });
        case "acknowledged":
          return emitEngineEvent({ _tag: "MutationAcknowledged", clientId, mutationId });
        case "rejected":
          return emitEngineEvent({
            _tag: "MutationRejected",
            clientId,
            mutationId,
            reason: reason ?? "",
          });
      }
    };
    // Project the three mutation variants back to the #36 `MutationEvent` shape.
    const toMutationEvent = (event: EngineEvent): MutationEvent | undefined => {
      switch (event._tag) {
        case "MutationJournaled":
          return { clientId: event.clientId, mutationId: event.mutationId, phase: "journaled" };
        case "MutationAcknowledged":
          return { clientId: event.clientId, mutationId: event.mutationId, phase: "acknowledged" };
        case "MutationRejected":
          return {
            clientId: event.clientId,
            mutationId: event.mutationId,
            phase: "rejected",
            reason: event.reason,
          };
        default:
          return undefined;
      }
    };
    // Sample the journal-depth gauge from the current pending count. Called on
    // every append (a new pending mutation) and acknowledge (a trim).
    const sampleJournalDepth: Effect.Effect<void> = store.pendingMutations.pipe(
      Effect.flatMap((pending) => Metric.update(Telemetry.journalDepth, pending.length)),
      Effect.catch(() => Effect.void)
    );
    // Time an effect and record its wall-clock duration (ms) as the rebase
    // histogram — wraps the actual overlay replay (cache misses only).
    const timedRebase = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        const result = yield* effect;
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        yield* Metric.update(Telemetry.rebaseDurationMs, elapsed);
        return result;
      });
    const forgetAck = (id: number): Effect.Effect<void> =>
      Ref.update(acks, (map) => {
        const next = new Map(map);
        next.delete(id);
        return next;
      });
    // Interrupt any still-pending outcome deferreds on scope close, so a caller
    // awaiting `acknowledged` never hangs and nothing leaks.
    yield* Effect.addFinalizer(() =>
      Ref.get(acks).pipe(
        Effect.flatMap((map) => Effect.forEach([...map.values()], Deferred.interrupt)),
        Effect.asVoid
      )
    );

    // Shared materialized overlay: `materialize` replays the whole journal, so
    // without a cache K observers of one change cost K full replays. Cache the
    // overlay and invalidate it whenever the journal or confirmed rows shift
    // (append/trim/pull), so one change costs one replay. The semaphore makes
    // the fill single-flight: concurrent observers waiting on the same change
    // recompute once, not once each.
    const overlayCache = yield* Ref.make<Map<string, Map<RowId, LocalRow>> | undefined>(undefined);
    const overlayLock = yield* Semaphore.make(1);
    const invalidateOverlay = Ref.set(overlayCache, undefined);

    /** Confirmed rows + pending mutations replayed on top (the overlay). */
    const computeOverlay: Effect.Effect<
      Map<string, Map<RowId, LocalRow>>,
      StoreError | MutatorError
    > = Effect.gen(function* () {
      const view = new Map<string, Map<RowId, LocalRow>>();
      const seeded = new Set<string>();

      const collectionView = (collection: string) => {
        const existing = view.get(collection);
        if (existing !== undefined) return Effect.succeed(existing);
        return Effect.gen(function* () {
          const created = new Map<RowId, LocalRow>();
          if (!seeded.has(collection)) {
            seeded.add(collection);
            for (const row of yield* store.listRows(collection)) {
              created.set(row.id, { id: row.id, value: row.value });
            }
          }
          view.set(collection, created);
          return created;
        });
      };

      const writer: LocalWriter = {
        put: (collection, id, value) =>
          collectionView(collection).pipe(
            Effect.map((rows) => {
              rows.set(id, { id, value });
            })
          ),
        del: (collection, id) =>
          collectionView(collection).pipe(
            Effect.map((rows) => {
              rows.delete(id);
            })
          ),
        get: (collection, id) =>
          collectionView(collection).pipe(Effect.map((rows) => rows.get(id)?.value)),
      };

      // Seed every collection we know about lazily via collectionView; then
      // replay pending mutations in journal order. Journal args are encoded
      // (they survive persistence and the wire), so decode before replay.
      for (const mutation of yield* store.pendingMutations) {
        const definition = options.mutators.mutators.get(mutation.mutator);
        const handler = options.mutators.handlers.get(mutation.mutator);
        if (definition === undefined || handler === undefined) {
          return yield* new MutatorError({
            message: `Unknown mutator: ${mutation.mutator}`,
            mutator: mutation.mutator,
          });
        }
        const args = yield* Schema.decodeUnknownEffect(definition.args)(mutation.args).pipe(
          Effect.mapError(
            (cause) =>
              new MutatorError({
                message: `Invalid journaled args for mutator "${mutation.mutator}"`,
                mutator: mutation.mutator,
                cause,
              })
          )
        );
        yield* handler(args, writer);
      }
      return view;
    });

    // Cached overlay getter: reuse the last materialization until it is
    // invalidated, computing under the lock so a burst of observers triggers a
    // single replay. Equivalent to `computeOverlay` by construction — the cache
    // is only ever reused inside a window where neither the journal nor the
    // confirmed rows changed (every append/trim/pull invalidates it first).
    const materialize: Effect.Effect<
      Map<string, Map<RowId, LocalRow>>,
      StoreError | MutatorError
    > = Semaphore.withPermit(
      overlayLock,
      Ref.get(overlayCache).pipe(
        Effect.flatMap((cached) =>
          cached !== undefined
            ? Effect.succeed(cached)
            : timedRebase(computeOverlay).pipe(Effect.tap((view) => Ref.set(overlayCache, view)))
        )
      )
    );

    // Which collections a mutation touches: run its local handler through a
    // writer that only records the collections its put/del name (get returns
    // undefined, nothing is mutated), so a scoped Rebuild can name exactly the
    // collections the mutation shifts. Returns undefined — the caller's cue to
    // fall back to a global rebuild — when the handler is unknown or errors.
    const collectionsTouchedBy = (
      mutator: string,
      decodedArgs: unknown
    ): Effect.Effect<ReadonlySet<string> | undefined> =>
      Effect.gen(function* () {
        const handler = options.mutators.handlers.get(mutator);
        if (handler === undefined) return undefined;
        const touched = new Set<string>();
        const record = (collection: string) =>
          Effect.sync(() => {
            touched.add(collection);
          });
        const writer: LocalWriter = {
          put: (collection) => record(collection),
          del: (collection) => record(collection),
          get: () => Effect.succeed(undefined),
        };
        yield* handler(decodedArgs, writer);
        return touched;
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    // The union of collections a batch of journaled mutations touches (their
    // args are encoded, so decode before tracking). Any unknown/undecodable
    // mutation collapses to undefined → a global rebuild.
    const collectionsTouchedByMutations = (
      mutations: ReadonlyArray<Mutation>
    ): Effect.Effect<ReadonlySet<string> | undefined> =>
      Effect.gen(function* () {
        const union = new Set<string>();
        for (const mutation of mutations) {
          const definition = options.mutators.mutators.get(mutation.mutator);
          if (definition === undefined) return undefined;
          const decoded = yield* Schema.decodeUnknownEffect(definition.args)(mutation.args).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          );
          const touched = yield* collectionsTouchedBy(mutation.mutator, decoded);
          if (touched === undefined) return undefined;
          for (const collection of touched) union.add(collection);
        }
        return union;
      });

    // All local rows of a collection (confirmed + overlay), loading confirmed
    // rows the overlay didn't already touch.
    const ensureCollection = (
      view: Map<string, Map<RowId, LocalRow>>,
      collection: string
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError> =>
      Effect.gen(function* () {
        const existing = view.get(collection);
        if (existing !== undefined) return [...existing.values()];
        const rows = new Map<RowId, LocalRow>();
        for (const row of yield* store.listRows(collection)) {
          rows.set(row.id, { id: row.id, value: row.value });
        }
        view.set(collection, rows);
        return [...rows.values()];
      });

    const collectionRows = (collection: string) =>
      materialize.pipe(Effect.flatMap((view) => ensureCollection(view, collection)));

    const query = (subset: Subset.Subset) =>
      collectionRows(subset.collection).pipe(Effect.map((rows) => Subset.apply(rows, subset)));

    // Route the whole patch through the store's batched bulk write, so a K-op
    // patch on a large collection costs K row-value writes + ~1 index rewrite
    // per touched collection — I/O scales with patch size, not collection size
    // (#47) — instead of one read-whole/rewrite-whole per op.
    const applyPatch = (ops: ReadonlyArray<PatchOp>): Effect.Effect<void, StoreError> =>
      store.applyRowOps(ops);

    // Resolve every pending deferred at or below `lastId` as applied, but only
    // report ids this call actually settled (a rejected mutation is already
    // settled, so `succeed` returns false and it is not re-reported).
    const settleApplied = (lastId: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [id, deferred] of yield* Ref.get(acks)) {
          if (id > lastId) continue;
          const won = yield* Deferred.succeed(deferred, { _tag: "applied" });
          if (won) yield* emitEvent(id, "acknowledged");
          yield* forgetAck(id);
        }
      });

    // Settle one mutation as permanently rejected; emit only if this call won
    // the race (it was not already settled).
    const rejectAck = (id: number, reason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deferred = (yield* Ref.get(acks)).get(id);
        if (deferred === undefined) return;
        const won = yield* Deferred.succeed(deferred, { _tag: "rejected", reason });
        if (won) yield* emitEvent(id, "rejected", reason);
        yield* forgetAck(id);
      });

    // Resolve deferreds for the mutations this client had permanently rejected.
    const settleRejected = (response: PushResponse): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of response.rejected ?? []) {
          if (entry.clientId !== options.clientId) continue;
          yield* rejectAck(entry.mutationId, entry.reason);
        }
      });

    const acknowledge = (lastMutationIds: Readonly<Record<string, number>>) =>
      Effect.gen(function* () {
        for (const [clientId, upTo] of Object.entries(lastMutationIds)) {
          yield* store.acknowledge(clientId, upTo);
        }
        const lastId = lastMutationIds[options.clientId];
        if (lastId !== undefined) yield* settleApplied(lastId);
        yield* invalidateOverlay; // trimming the journal shifts the overlay
        yield* sampleJournalDepth; // the trim changed journal depth
      });

    // Latch so an ongoing schema-version rejection (#48) fires `onUpdateNeeded`
    // and the `UpdateNeeded` event exactly once — a retry storm or repeated
    // pulls against the same rejection do not refire it. The latch resets on the
    // next successful request, so a fresh rejection after an interim success
    // notifies again. A version rejection never trims the journal: pending
    // intents are retained across it, ready to push once the build is updated.
    const updateNeededLatch = yield* Ref.make(false);
    const infoOf = (error: VersionNotSupportedError) => ({
      ...(error.schemaVersion !== undefined ? { schemaVersion: error.schemaVersion } : {}),
      message: error.message,
    });
    const onVersionError = (error: VersionNotSupportedError): Effect.Effect<void> =>
      Ref.getAndSet(updateNeededLatch, true).pipe(
        Effect.flatMap((already) =>
          already
            ? Effect.void
            : emitEngineEvent({ _tag: "UpdateNeeded", ...infoOf(error) }).pipe(
                Effect.andThen(options.onUpdateNeeded?.(infoOf(error)) ?? Effect.void)
              )
        )
      );
    const resetUpdateLatch = Ref.set(updateNeededLatch, false);
    // Fire `onVersionError` on a version rejection, reset the latch on success;
    // shared by push and pull so both dedupe against one latch.
    const withVersionLatch = <A, E extends { readonly _tag: string }, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      effect.pipe(
        Effect.tap(() => resetUpdateLatch),
        Effect.tapError((error) =>
          error._tag === "VersionNotSupportedError"
            ? onVersionError(error as unknown as VersionNotSupportedError)
            : Effect.void
        )
      );

    const push: ClientEngine["push"] = withVersionLatch(
      Effect.gen(function* () {
        const pending = yield* store.pendingMutations;
        if (pending.length === 0) return;
        yield* emitEngineEvent({ _tag: "PushStarted" });
        const response = yield* transport.push({
          clientGroupId: options.clientGroupId,
          mutations: pending,
          ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
        });
        // Trimming these pending mutations drops their optimistic effects, so
        // only their collections can shift — scope the rebuild to that union so
        // observers of untouched collections don't re-materialize.
        const touched = yield* collectionsTouchedByMutations(pending);
        // Settle permanently-rejected mutations before the ack sweep, so a
        // rejected id reports `rejected` rather than `applied`.
        yield* settleRejected(response);
        // Effects arrive via the next pull; the ack only trims the journal.
        yield* acknowledge(response.lastMutationIds);
        yield* publishChange(rebuildFor(touched));
        yield* Metric.update(Telemetry.mutationsPushedTotal, pending.length);
        yield* Metric.update(Telemetry.pushesTotal, 1);
        yield* Metric.update(Telemetry.pushMutations, pending.length);
        yield* emitEngineEvent({ _tag: "PushCompleted", mutations: pending.length });
      })
    ).pipe(Effect.withSpan(Telemetry.span.clientPush));

    // The distinct collections a pulled patch touches, computed before the
    // patch is applied so a `Clear` can stand for every collection the client
    // currently holds (the patch would otherwise wipe them). Put/Del name their
    // collection directly. Drives collection-scoped reactions (HTTP-cache tag
    // invalidation) via the `PullCompleted` event.
    const pullTouchedCollections = (
      patch: ReadonlyArray<PatchOp>
    ): Effect.Effect<ReadonlyArray<string>, StoreError> =>
      Effect.gen(function* () {
        const touched = new Set<string>();
        let cleared = false;
        for (const op of patch) {
          if (op._tag === "Clear") cleared = true;
          else touched.add(op.collection);
        }
        if (cleared) {
          for (const collection of yield* store.listCollections) touched.add(collection);
        }
        return [...touched];
      });

    const applyPull = (response: PullResponse): Effect.Effect<ReadonlyArray<string>, StoreError> =>
      Effect.gen(function* () {
        // With an empty journal the patch ops are exactly the materialized-view
        // deltas, so observers maintain incrementally; with a pending overlay (or
        // a reset) the overlay could shift any row, so fall back to a rebuild.
        const hadPending = (yield* store.pendingMutations).length > 0;
        const hasClear = response.patch.some((op) => op._tag === "Clear");
        const touched = yield* pullTouchedCollections(response.patch);
        yield* applyPatch(response.patch);
        yield* acknowledge(response.lastMutationIds);
        yield* store.setCookie(response.cookie);
        // Atomic reveal: one change event after patch + ack (rebase is
        // recomputation in `materialize`).
        yield* publishChange(
          hadPending || hasClear ? REBUILD : { _tag: "Patch", ops: response.patch }
        );
        return touched;
      });

    const pull: ClientEngine["pull"] = withVersionLatch(
      Effect.gen(function* () {
        yield* emitEngineEvent({ _tag: "PullStarted" });
        const cookie = yield* store.getCookie;
        const subsets = yield* Ref.get(subscriptions);
        const named = yield* Ref.get(namedSubs);
        const namedSubscriptions: ReadonlyArray<NamedSubscription> = named.map((entry) => ({
          name: entry.name,
          args: entry.argsEncoded,
        }));
        const response = yield* transport.pull({
          clientGroupId: options.clientGroupId,
          cookie,
          subscriptions: subsets,
          ...(namedSubscriptions.length > 0 ? { namedSubscriptions } : {}),
          ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
        });
        const collections = yield* applyPull(response);
        yield* Metric.update(Telemetry.pullsTotal, 1);
        yield* Metric.update(Telemetry.pullPatchOps, response.patch.length);
        yield* emitEngineEvent({
          _tag: "PullCompleted",
          ops: response.patch.length,
          collections,
        });
      })
    ).pipe(Effect.withSpan(Telemetry.span.clientPull));

    const subscribeSubset = (subset: Subset.Subset): Effect.Effect<void> =>
      Ref.update(subscriptions, (current) =>
        current.some((s) => Subset.hash(s) === Subset.hash(subset)) ? current : [...current, subset]
      );

    // Seed confirmed rows and reveal them with one scoped rebuild, so observers
    // of the seeded collections re-materialize while others stay put. Confirmed
    // rows shifted, so the overlay cache is invalidated first.
    const seed: ClientEngine["seed"] = (rows) =>
      Effect.gen(function* () {
        const touched = new Set<string>();
        for (const row of rows) {
          yield* store.putRow(row.collection, {
            id: row.id,
            version: row.version,
            value: row.value,
          });
          touched.add(row.collection);
        }
        yield* invalidateOverlay;
        yield* publishChange(rebuildFor(touched));
      });

    // Register or reuse the in-flight pull for a subset. Returns the deferred to
    // await plus whether this call owns the pull (only the owner runs it), so
    // concurrent prefetches of one subset collapse to a single pull.
    type PullDeferred = Deferred.Deferred<
      void,
      TransportError | StoreError | MutatorError | VersionNotSupportedError
    >;
    type PullMap = Map<string, PullDeferred>;
    type PullClaim = { readonly deferred: PullDeferred; readonly owner: boolean };
    const claimPull = (hash: string, own: PullDeferred): Effect.Effect<PullClaim> =>
      Ref.modify(ensurePulls, (map): readonly [PullClaim, PullMap] => {
        const existing = map.get(hash);
        return existing !== undefined
          ? [{ deferred: existing, owner: false }, map]
          : [{ deferred: own, owner: true }, new Map(map).set(hash, own)];
      });

    const releasePull = (hash: string): Effect.Effect<void> =>
      Ref.update(ensurePulls, (map) => {
        const next = new Map(map);
        next.delete(hash);
        return next;
      });

    // A single deduped pull for a subset: the owner runs `pull` and settles the
    // shared deferred; everyone else just awaits it.
    const dedupedPull = (
      subset: Subset.Subset
    ): Effect.Effect<void, TransportError | StoreError | MutatorError | VersionNotSupportedError> =>
      Effect.gen(function* () {
        const hash = Subset.hash(subset);
        const own = yield* Deferred.make<
          void,
          TransportError | StoreError | MutatorError | VersionNotSupportedError
        >();
        const { deferred, owner } = yield* claimPull(hash, own);
        if (!owner) return yield* Deferred.await(deferred);
        const exit = yield* Effect.exit(pull);
        yield* releasePull(hash);
        yield* Deferred.done(own, exit);
        return yield* Deferred.await(own);
      });

    const ensureSubset: ClientEngine["ensureSubset"] = (subset) =>
      Effect.gen(function* () {
        yield* subscribeSubset(subset);
        const rows = yield* query(subset);
        if (rows.length > 0) return;
        yield* dedupedPull(subset);
      });

    // Retry only transient (transport) failures; store/mutator errors are not
    // transient and go straight to the failure surface.
    const isTransient = (error: { readonly _tag: string }): boolean =>
      error._tag === "TransportError";

    const pushPolicy = options.retry?.push ?? defaultRetryPolicy;
    const pullPolicy = options.retry?.pull ?? defaultRetryPolicy;
    const pokePolicy = options.retry?.pokes ?? defaultRetryPolicy;

    // A network leg that survives transient failure via its policy, then
    // surfaces (never raises) whatever it could not recover from.
    // A version rejection (#48) is already handled by `onUpdateNeeded` inside
    // push/pull and is not a transient failure to retry or a terminal
    // `SyncFailure` to surface, so the loop swallows it here (the app was
    // already told to update). The journal is untouched, so pending intents
    // wait for an updated build.
    const attemptPush = push.pipe(
      Effect.retry({ schedule: pushPolicy, while: isTransient }),
      Effect.catchTag("VersionNotSupportedError", () => Effect.void),
      Effect.catch((error) => surfaceFailure("push", error))
    );
    const attemptPull = pull.pipe(
      Effect.retry({ schedule: pullPolicy, while: isTransient }),
      Effect.catchTag("VersionNotSupportedError", () => Effect.void),
      Effect.catch((error) => surfaceFailure("pull", error))
    );

    const runSync: ClientEngine["runSync"] = Effect.gen(function* () {
      // Pull on every poke; re-establish the poke stream with backoff, and
      // surface if it stays down (the replay-1 hub covers the resubscribe race).
      yield* Effect.forkScoped(
        Stream.runForEach(transport.pokes.pipe(Stream.retry(pokePolicy)), (poke) =>
          emitEngineEvent({
            _tag: "PokeReceived",
            ...(poke.reason !== undefined ? { reason: poke.reason } : {}),
          }).pipe(Effect.andThen(attemptPull))
        ).pipe(Effect.catch((error) => surfaceFailure("pokes", error)))
      );
      // Push + pull on (re)connect.
      yield* Effect.forkScoped(
        Stream.runForEach(transport.statusChanges, (status) =>
          status === "connected" ? attemptPush.pipe(Effect.andThen(attemptPull)) : Effect.void
        )
      );
      // Auto-push after mutations, debounced so a burst coalesces into one push.
      const pushDebounce = options.syncLoop?.pushDebounce;
      if (pushDebounce !== undefined) {
        yield* Effect.forkScoped(
          Stream.fromPubSub(pushTrigger).pipe(
            Stream.debounce(pushDebounce),
            Stream.runForEach(() => attemptPush)
          )
        );
      }
      // Periodic pull: the correctness backstop when no pokes arrive.
      const pullInterval = options.syncLoop?.pullInterval;
      if (pullInterval !== undefined) {
        yield* Effect.forkScoped(attemptPull.pipe(Effect.repeat(Schedule.spaced(pullInterval))));
      }
    });

    const definitionOf = (mutator: string) => {
      const definition = options.mutators.mutators.get(mutator);
      return definition === undefined || !options.mutators.handlers.has(mutator)
        ? Effect.fail(new MutatorError({ message: `Unknown mutator: ${mutator}`, mutator }))
        : Effect.succeed(definition);
    };

    // Named queries: resolve a name to its client-side definition + subset.
    const queryDefOf = (
      name: string
    ): Effect.Effect<
      { readonly definition: Query.AnyQuery; readonly local: Query.LocalQuery<any> },
      QueryError
    > => {
      const definition = options.queries?.queries.get(name);
      const local = options.queries?.locals.get(name);
      return definition === undefined || local === undefined
        ? Effect.fail(new QueryError({ message: `Unknown query: ${name}`, query: name }))
        : Effect.succeed({ definition, local });
    };
    const localSubsetOf = (name: string, args: unknown): Effect.Effect<Subset.Subset, QueryError> =>
      queryDefOf(name).pipe(Effect.map(({ local }) => local(args)));
    const encodeQueryArgs = (name: string, args: unknown): Effect.Effect<unknown, QueryError> =>
      queryDefOf(name).pipe(
        Effect.flatMap(({ definition }) =>
          Schema.encodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(
              (cause) =>
                new QueryError({ message: `Invalid args for query "${name}"`, query: name, cause })
            )
          )
        )
      );
    const namedKey = (name: string, argsEncoded: unknown) =>
      `${name}:${Hash.canonicalJson(argsEncoded)}`;
    // Encode + key a named subscription, then update the registry with both.
    const updateNamedSubs = (
      name: string,
      args: unknown,
      update: (
        current: ReadonlyArray<{ name: string; argsEncoded: unknown; key: string }>,
        entry: { name: string; argsEncoded: unknown; key: string }
      ) => ReadonlyArray<{ name: string; argsEncoded: unknown; key: string }>
    ): Effect.Effect<void, QueryError> =>
      encodeQueryArgs(name, args).pipe(
        Effect.flatMap((argsEncoded) =>
          Ref.update(namedSubs, (current) =>
            update(current, { name, argsEncoded, key: namedKey(name, argsEncoded) })
          )
        )
      );
    // Apply a Patch's confirmed deltas for one collection to a LiveView.
    const applyOps = (
      view: LiveView.LiveView,
      collection: string,
      ops: ReadonlyArray<PatchOp>
    ): LiveView.LiveView => {
      let next = view;
      for (const op of ops) {
        if (op._tag === "Clear" || op.collection !== collection) continue;
        next =
          op._tag === "Put"
            ? LiveView.put(next, { id: op.id, value: op.value })
            : LiveView.del(next, op.id);
      }
      return next;
    };

    const sameResult = (a: ReadonlyArray<LocalRow>, b: ReadonlyArray<LocalRow>): boolean =>
      a.length === b.length &&
      a.every((row, i) => row.id === b[i]!.id && row.value === b[i]!.value);

    // A scoped rebuild that doesn't name the observed collection cannot have
    // moved it, so the observer keeps its page (and `changesWith` dedups the
    // re-emit). An unscoped rebuild (collections undefined) always recomputes.
    const rebuildSkips = (change: ViewChange, collection: string): boolean =>
      change._tag === "Rebuild" &&
      change.collections !== undefined &&
      !change.collections.has(collection);

    // Apply one contiguous change (no drop before it) to a query's LiveView and
    // return its current page — the incremental fast path, unchanged from the
    // unbounded-hub behaviour.
    const applyContiguous = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      subset: Subset.Subset,
      change: ViewChange
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError> =>
      Effect.gen(function* () {
        const view = yield* Ref.get(viewRef);
        if (rebuildSkips(change, subset.collection)) return LiveView.result(view);
        const next =
          change._tag === "Rebuild"
            ? LiveView.make(subset, yield* collectionRows(subset.collection))
            : applyOps(view, subset.collection, change.ops);
        if (next !== view) yield* Ref.set(viewRef, next);
        return LiveView.result(next);
      });

    // A drop happened before this seq: collapse it into a full Rebuild. Read
    // the latest assigned seq FIRST, then re-materialize — the store then
    // reflects every change with seq ≤ latest, so advancing `lastSeenRef` to
    // `latest` safely skips any still-buffered changes already folded into this
    // rebuild (they would otherwise re-apply as stale, regressing rows). A
    // Rebuild subsumes the dropped Patches (ADR-0008), so the view is correct.
    const collapseToRebuild = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      lastSeenRef: Ref.Ref<number>,
      subset: Subset.Subset
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError> =>
      Effect.gen(function* () {
        yield* Metric.update(Telemetry.changeCollapsesTotal, 1);
        const latest = yield* Ref.get(changeSeq);
        const next = LiveView.make(subset, yield* collectionRows(subset.collection));
        yield* Ref.set(viewRef, next);
        yield* Ref.set(lastSeenRef, latest);
        return LiveView.result(next);
      });

    // Advance a query's LiveView for one sequenced change and return its page.
    // Contiguous seq → incremental apply; a gap (a bounded-hub drop) → lossless
    // Rebuild collapse; a seq at/below the last seen → already reflected, skip.
    const stepView = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      lastSeenRef: Ref.Ref<number>,
      subset: Subset.Subset,
      item: SeqChange
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError> =>
      Effect.gen(function* () {
        const lastSeen = yield* Ref.get(lastSeenRef);
        if (item.seq <= lastSeen) return LiveView.result(yield* Ref.get(viewRef));
        if (item.seq === lastSeen + 1) {
          yield* Ref.set(lastSeenRef, item.seq);
          return yield* applyContiguous(viewRef, subset, item.change);
        }
        return yield* collapseToRebuild(viewRef, lastSeenRef, subset);
      });

    const observeSubset = (subset: Subset.Subset) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe BEFORE snapshotting (#84): the hub only delivers to
          // live subscribers, so a change published while we materialize
          // must land in this subscription's buffer — subscribing after the
          // snapshot silently loses it, and with no later change to reveal
          // the seq gap the observer sleeps through the write forever. A
          // buffered change the snapshot already reflects steps as a stale
          // seq (skip) or an idempotent re-apply.
          const subscription = yield* PubSub.subscribe(changes);
          // Capture the seq before materializing: the view then reflects the
          // store at ≥ this seq, so the first live change is contiguous.
          const startSeq = yield* Ref.get(changeSeq);
          const viewRef = yield* Ref.make(
            LiveView.make(subset, yield* collectionRows(subset.collection))
          );
          const lastSeenRef = yield* Ref.make(startSeq);
          const initial = LiveView.result(yield* Ref.get(viewRef));
          // Emit the page on each change, dropping re-emits when it didn't move
          // (e.g. a change outside the limit window, or a skipped stale seq).
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((item) => stepView(viewRef, lastSeenRef, subset, item))
            )
          ).pipe(Stream.changesWith(sameResult));
        })
      );
    // Projected observe: map each page through `select` and drop consecutive
    // equal projections, so a change to a field the projection ignores never
    // re-emits. Without `select` it is the plain rows stream (whole-page dedup
    // still handled inside `observeSubset`).
    const observeProjected = <B>(
      subset: Subset.Subset,
      options?: ObserveOptions<LocalRow, B>
    ): Stream.Stream<B | ReadonlyArray<LocalRow>, StoreError | MutatorError> => {
      const base = observeSubset(subset);
      if (options === undefined) return base;
      const equals = options.equals ?? ((a: B, b: B) => a === b);
      return base.pipe(Stream.map(options.select), Stream.changesWith(equals));
    };

    const queryAggregate = (subset: Subset.Subset, agg: Aggregate.Aggregate) =>
      query(subset).pipe(Effect.map((rows) => Aggregate.compute(agg, rows)));
    const queryAggregateGrouped = (
      subset: Subset.Subset,
      agg: Aggregate.Aggregate,
      groupBy: string
    ) => query(subset).pipe(Effect.map((rows) => Aggregate.computeGrouped(agg, rows, groupBy)));
    const observeAggregate = (subset: Subset.Subset, agg: Aggregate.Aggregate) =>
      Aggregate.observe(observeSubset(subset), agg);
    const observeAggregateGrouped = (
      subset: Subset.Subset,
      agg: Aggregate.Aggregate,
      groupBy: string
    ) => Aggregate.observeGrouped(observeSubset(subset), agg, groupBy);

    const invalidArgs = (mutator: string) => (cause: unknown) =>
      new MutatorError({ message: `Invalid args for mutator "${mutator}"`, mutator, cause });
    const journal = (mutator: string, encoded: unknown, decodedArgs: unknown) =>
      Effect.gen(function* () {
        const mutationId = yield* store.nextMutationId(options.clientId);
        const mutation: Mutation = {
          clientId: options.clientId,
          mutationId,
          mutator,
          args: encoded,
          createdAt: yield* Clock.currentTimeMillis,
        };
        yield* store.appendMutation(mutation);
        yield* invalidateOverlay; // the new pending mutation shifts the overlay
        yield* sampleJournalDepth; // the append changed journal depth
        yield* emitEvent(mutationId, "journaled");
        // Scope the rebuild to the collections this mutation writes, so
        // observers of other collections don't re-materialize.
        const touched = yield* collectionsTouchedBy(mutator, decodedArgs);
        yield* publishChange(rebuildFor(touched));
        yield* signalPush; // the sync loop may auto-push this (debounced)
        return mutationId;
      });
    // Validate the decoded args now (fail fast at the call site) and produce the
    // journal's encoded (wire/persistence) form — shared by `mutate` and
    // `mutateWithAck`.
    const encodeFor = (mutator: string, args: unknown): Effect.Effect<unknown, MutatorError> =>
      Effect.gen(function* () {
        const definition = yield* definitionOf(mutator);
        return yield* Schema.encodeUnknownEffect(definition.args)(args).pipe(
          Effect.mapError(invalidArgs(mutator))
        );
      });

    // Resolve one named subscription to its local subset, skipping (undefined)
    // any whose args can no longer decode or whose query is unregistered — a
    // read-only best effort for introspection, never a failure.
    const resolveNamedSubset = (entry: {
      readonly name: string;
      readonly argsEncoded: unknown;
    }): Effect.Effect<Subset.Subset | undefined> =>
      queryDefOf(entry.name).pipe(
        Effect.flatMap(({ definition, local }) =>
          Schema.decodeUnknownEffect(definition.args)(entry.argsEncoded).pipe(
            Effect.map((decoded) => local(decoded))
          )
        ),
        Effect.catch(() => Effect.succeed(undefined))
      );

    // Read-only snapshot of every active subset: raw subscriptions plus each
    // named subscription resolved through its local factory. The introspection
    // seam — reads the Refs internally, exposes only the resolved subsets.
    const activeSubscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>> = Effect.gen(
      function* () {
        const raw = yield* Ref.get(subscriptions);
        const named = yield* Ref.get(namedSubs);
        const resolved: Array<Subset.Subset> = [];
        for (const entry of named) {
          const subset = yield* resolveNamedSubset(entry);
          if (subset !== undefined) resolved.push(subset);
        }
        return [...raw, ...resolved];
      }
    );

    return ClientEngine.of({
      mutate: (mutator, args) =>
        encodeFor(mutator, args).pipe(
          Effect.flatMap((encoded) => journal(mutator, encoded, args)),
          Effect.asVoid
        ),
      mutateEncoded: (mutator, args) =>
        Effect.gen(function* () {
          const definition = yield* definitionOf(mutator);
          // Decoding validates the encoded form; the journal keeps it as-is.
          const decoded = yield* Schema.decodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(invalidArgs(mutator))
          );
          yield* journal(mutator, args, decoded);
        }),
      mutateWithAck: (mutator, args) =>
        Effect.gen(function* () {
          const encoded = yield* encodeFor(mutator, args);
          const mutationId = yield* journal(mutator, encoded, args);
          const deferred = yield* Deferred.make<MutationOutcome>();
          yield* Ref.update(acks, (map) => new Map(map).set(mutationId, deferred));
          return { mutationId, acknowledged: Deferred.await(deferred) };
        }),
      subscribe: subscribeSubset,
      seed,
      ensureSubset,
      unsubscribe: (subset) =>
        Ref.update(subscriptions, (current) =>
          current.filter((s) => Subset.hash(s) !== Subset.hash(subset))
        ),
      subscribeQuery: (name, args) =>
        updateNamedSubs(name, args, (current, entry) =>
          current.some((e) => e.key === entry.key) ? current : [...current, entry]
        ).pipe(Effect.andThen(publishChange(REBUILD))),
      unsubscribeQuery: (name, args) =>
        updateNamedSubs(name, args, (current, entry) => current.filter((e) => e.key !== entry.key)),
      query: query as ClientEngine["query"],
      queryNamed: (name, args) => localSubsetOf(name, args).pipe(Effect.flatMap(query)),
      observe: observeProjected as ClientEngine["observe"],
      queryAggregate,
      queryAggregateGrouped,
      observeAggregate,
      observeAggregateGrouped,
      observeNamed: (name, args) =>
        Stream.unwrap(localSubsetOf(name, args).pipe(Effect.map(observeSubset))),
      push,
      pull,
      ...(transport.read === undefined
        ? {}
        : {
            readThrough: (subsets: ReadonlyArray<Subset.Subset>) =>
              transport.read!({
                clientGroupId: options.clientGroupId,
                subsets,
                ...(options.schemaVersion === undefined
                  ? {}
                  : { schemaVersion: options.schemaVersion }),
              }).pipe(Effect.map((response) => response.rows)),
          }),
      runSync,
      syncFailures: Stream.fromPubSub(failures),
      engineEvents: Stream.fromPubSub(engineEventsHub),
      activeSubscriptions,
      // #36's mutation stream, now a filtered projection of the one hub (#45).
      mutationEvents: Stream.fromPubSub(engineEventsHub).pipe(
        Stream.map(toMutationEvent),
        Stream.filter((event): event is MutationEvent => event !== undefined)
      ),
    });
  });

/** Layer building the engine from ClientStore + ClientTransport. */
export const layer = (
  options: ClientEngineOptions
): Layer.Layer<ClientEngine, never, ClientStore | ClientTransport> =>
  Layer.effect(ClientEngine)(make(options));
