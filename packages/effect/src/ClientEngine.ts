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
  SubscriptionRef,
} from "effect";
import * as Aggregate from "./Aggregate.js";
import type { RowId, RowVersion } from "./Collection.js";
import { ClientStore, NO_COMPACTION, freezePending, type CompactionResult } from "./ClientStore.js";
import * as Hash from "./Hash.js";
import * as Identity from "./Identity.js";
import * as Index from "./CollectionIndex.js";
import {
  MutatorError,
  QueryError,
  StoreError,
  TransportError,
  VersionNotSupportedError,
} from "./Errors.js";
import * as LiveView from "./LiveView.js";
import type { LocalWriter, MutatorRegistry } from "./Mutator.js";
import * as MutationState from "./MutationState.js";
import type * as PredicateModule from "./Predicate.js";
import type {
  Mutation,
  NamedSubscription,
  PatchOp,
  PullResponse,
  PushResponse,
  ReadResponse,
} from "./Protocol.js";
import * as Query from "./Query.js";
import * as RowChange from "./RowChange.js";
import * as Telemetry from "./Telemetry.js";
import { ClientTransport } from "./Transport.js";
import * as Subset from "./Subset.js";

export type { RowChange } from "./RowChange.js";

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
 * Options for {@link ClientEngine.observeChanges}. `includeInitial` emits the
 * current window as `enter`s in the first batch (TanStack's
 * `currentStateAsChanges`/`includeInitialState`); the default `false` waits
 * for the first live change.
 */
export interface ObserveChangesOptions {
  readonly includeInitial?: boolean;
}

/**
 * `limit`/`cursor` to widen or advance an open {@link ClientEngine.observeWindow}
 * observation (mirrors `LiveView.retarget`) — an omitted field leaves that
 * side of the window where it is.
 */
export interface WindowRetarget {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A reactively-retargetable live window (#133): `rows` is the same live page
 * stream {@link ClientEngine.observe} would give this subset; `retarget`
 * widens/advances its `limit`/`cursor` in place — reusing `LiveView`'s
 * maintained order (`LiveView.retarget`: no re-subscribe, no rebuild from
 * scratch) — and widens this subset's entry in the engine's subscription
 * list so the next `pull` fetches the wider window from the server too.
 * `collection`/`where`/`orderBy` are fixed at `observeWindow` time; only
 * `limit`/`cursor` move.
 */
export interface WindowObservation {
  readonly rows: Stream.Stream<ReadonlyArray<LocalRow>, StoreError | MutatorError>;
  readonly retarget: (window: WindowRetarget) => Effect.Effect<void>;
}

/**
 * A mutation's authoritative (server) outcome: `applied` once the backend
 * acknowledged it with effects, or `rejected` with a reason when the backend
 * permanently refused it (#35). Observed via {@link MutationHandle}.
 */
export type MutationOutcome =
  { readonly _tag: "applied" } | { readonly _tag: "rejected"; readonly reason: string };

/**
 * A handle to a journaled mutation whose backend outcome can be awaited. The
 * `acknowledged` effect resolves once the backend settles the mutation (via a
 * push or pull acknowledgement); it is interrupted if the engine scope closes
 * first, so it never hangs.
 *
 * `mutationId` is the id the mutation was journaled under. While the entry is
 * still unpushed a paced compaction (#249) may renumber it to keep the
 * journal gap-free (the backend rejects gaps), so treat the id as a label for
 * *now*: `acknowledged` follows the entry through any renumbering, and
 * `MutationRenumbered` on {@link ClientEngine.engineEvents} reports each move.
 * Once a push has claimed the entry its id never changes again. If a
 * compaction supersedes the entry instead, `acknowledged` is interrupted.
 */
export interface MutationHandle {
  readonly mutationId: number;
  readonly acknowledged: Effect.Effect<MutationOutcome>;
}

/**
 * A mutation lifecycle event on {@link ClientEngine.mutationEvents}: emitted
 * when a mutation is `journaled` locally, then when the backend `acknowledged`
 * (applied) or `rejected` it — or, for a still-unpushed entry, when a paced
 * strategy (#117: debounce/throttle/coalesce) `dropped` it via
 * `dropIfPending` in favour of a newer entry for the same key. Every
 * journaled mutation emits `journaled`, whether it came from `mutate`,
 * `mutateEncoded`, or `mutateWithAck`.
 *
 * A paced compaction's `MutationRenumbered` (#249) is **not** projected onto
 * this stream: its `phase` union describes one mutation's lifecycle, and a
 * renumber is not a phase. Consumers that correlate by id read it from
 * {@link ClientEngine.engineEvents}, or just follow `mutationStates` (which
 * moves the state to the new id).
 */
export interface MutationEvent {
  readonly clientId: string;
  readonly mutationId: number;
  readonly phase: "journaled" | "acknowledged" | "rejected" | "dropped";
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
 * - `MutationDropped` — a paced strategy (#117) compacted a still-unpushed
 *   entry out of the journal in favour of a newer one for the same key; the
 *   entry never reached the backend.
 * - `MutationRenumbered` — the same compaction moved a surviving, still-
 *   unpushed entry from `previousMutationId` to `mutationId` so the client's
 *   ids stay contiguous (#249). Emitted after the compaction's `MutationDropped`
 *   events; an id seen in either may now name a different entry.
 * - `PushStarted` / `PushCompleted` — a push began / finished (with the number
 *   of `mutations` delivered).
 * - `PullStarted` / `PullCompleted` — a pull began / finished (with the number
 *   of patch `ops` applied, the distinct `collections` those ops touched, and
 *   the individual `rows` — (collection, id) pairs — a `Put`/`Del` touched; a
 *   `Clear` stands for every collection the client currently holds, since it
 *   resets the whole view, and contributes no `rows` (there is no finite row
 *   list for "everything"). The touched collections and rows drive
 *   collection- and row-scoped reactions such as HTTP-cache tag invalidation
 *   (`@thomasfosterau/legation-browser`'s `HttpCacheInvalidation`, #207), which is why they
 *   are reported even on a client with an empty journal (the common case,
 *   where a pull emits a `Patch` change and no `ViewRebuilt`).
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
  | {
      readonly _tag: "MutationDropped";
      readonly clientId: string;
      readonly mutationId: number;
    }
  | {
      readonly _tag: "MutationRenumbered";
      readonly clientId: string;
      readonly previousMutationId: number;
      readonly mutationId: number;
    }
  | { readonly _tag: "PushStarted" }
  | { readonly _tag: "PushCompleted"; readonly mutations: number }
  | { readonly _tag: "PullStarted" }
  | {
      readonly _tag: "PullCompleted";
      readonly ops: number;
      readonly collections: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<{ readonly collection: string; readonly id: RowId }>;
    }
  | { readonly _tag: "PokeReceived"; readonly reason?: string }
  | { readonly _tag: "ViewRebuilt"; readonly collections?: ReadonlyArray<string> }
  | {
      readonly _tag: "UpdateNeeded";
      readonly schemaVersion?: string;
      readonly message: string;
    };

/**
 * A row-level delta produced by a mutator's local handler (#109): unlike a
 * `PatchOp`, it carries no server version — the row is optimistic, not yet
 * confirmed. Structurally interchangeable with `PatchOp`'s `Put`/`Del` for
 * `LiveView` folding, which never reads `version`.
 */
type OverlayOp =
  | {
      readonly _tag: "Put";
      readonly collection: string;
      readonly id: RowId;
      readonly value: unknown;
    }
  | { readonly _tag: "Del"; readonly collection: string; readonly id: RowId };

/**
 * A local-view change. `Patch` carries per-row deltas that drive incremental
 * `LiveView` maintenance: confirmed-row ops from a pull (only when the journal
 * was empty, so they equal the materialized-view deltas) or the ops a mutator's
 * local handler just performed on the optimistic overlay (#109). `Rebuild` is
 * the conservative fallback when the overlay could have shifted in a way we
 * did not track precisely, so observers re-materialize; its `collections`
 * names exactly which collections the shift touched, so an observer of a
 * collection outside the set skips the recompute. `collections` left
 * `undefined` means "any collection" — the global fallback for changes we
 * cannot scope precisely (a `Clear`, an unknown mutator, a handler that threw).
 */
type ViewChange =
  | { readonly _tag: "Patch"; readonly ops: ReadonlyArray<PatchOp | OverlayOp> }
  | { readonly _tag: "Rebuild"; readonly collections?: ReadonlySet<string> };

/** The global rebuild: `collections` undefined, so every observer re-materializes. */
const REBUILD: ViewChange = { _tag: "Rebuild" };

// What a journaled mutation's local effects are applied onto (#260): the warm
// overlay cache, or the overlay journal from before the append to replay into
// a cold one. Read under `overlayLock`, so the journal is only read when the
// cache is cold.
type OverlayBase =
  | { readonly _tag: "Warm"; readonly view: Map<string, Map<RowId, LocalRow>> }
  | { readonly _tag: "Cold"; readonly journalBefore: ReadonlyArray<Mutation> };

/** A rebuild scoped to `collections`, or the global {@link REBUILD} when undefined. */
const rebuildFor = (collections: ReadonlySet<string> | undefined): ViewChange =>
  collections === undefined ? REBUILD : { _tag: "Rebuild", collections };

/**
 * Most acknowledged-but-unpulled mutations the engine keeps in the overlay
 * (#286). A push acknowledges entries that the next pull reports; if pulls
 * never arrive, the oldest are released past this bound (with a
 * `logWarning`), so the tail cannot grow without limit.
 */
const UNPULLED_LIMIT = 1024;

/**
 * Whether a `lastMutationIds` watermark covers `mutation`: its client's
 * watermark is at or above the mutation's id.
 */
const isCoveredBy = (
  lastMutationIds: Readonly<Record<string, number>>,
  mutation: Mutation
): boolean => {
  const upTo: number | undefined = lastMutationIds[mutation.clientId];
  return upTo !== undefined && mutation.mutationId <= upTo;
};

// A windowed subset (limit/cursor) can't fold an aggregate incrementally
// without also tracking window-boundary shifts (a delta outside the window
// can still evict/admit a row at its edge, which a row-level delta alone
// doesn't reveal) — `observeAggregate`/`observeAggregateGrouped` refold the
// page each emission for these, same as before #110. An unwindowed subset
// (the common case: aggregate over everything synced) folds `Patch` ops in
// place instead.
const isWindowed = (subset: Subset.Subset): boolean =>
  subset.limit !== undefined || subset.cursor !== undefined;

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
   * journal already batches naturally). Unset, a journaled mutation is not
   * pushed until something else triggers one — a reconnect, a poke-driven
   * pull cycle, or an explicit `push` — so on an already-connected client it
   * can sit in the journal indefinitely, with nothing surfaced as an error.
   * The examples and `examples/commerce`'s host use `"300 millis"`.
   */
  readonly pushDebounce?: Duration.Input;
  /**
   * Periodic pull as the correctness backstop, so the client converges over
   * pull alone even when no pokes arrive ("pull is the correctness path").
   * Unset, convergence depends entirely on pokes arriving — if the poke
   * stream drops or never connects, nothing else notices until a reconnect
   * or an explicit `pull`.
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
export const defaultRetryPolicy: Schedule.Schedule<unknown, unknown> = Schedule.max([
  Schedule.min([
    Schedule.exponential(Duration.seconds(1), 2),
    Schedule.spaced(Duration.seconds(30)),
  ]),
  Schedule.recurs(5),
]);

/**
 * What {@link ClientEngine.reset} did — an identity change is not a silent
 * operation, so the caller is told which branch of the boundary's transition
 * rule ran and what it moved.
 */
export interface ResetOutcome {
  /** The branch {@link Identity.transitionOf} chose. */
  readonly transition: Identity.Transition;
  /** The superseded fingerprint the journal was quarantined under, on a `Reset`. */
  readonly quarantinedUnder?: Identity.Fingerprint;
  /** How many unpushed entries moved into that quarantine. */
  readonly quarantined: number;
  /** How many entries the adopted identity's own quarantine released back into the journal. */
  readonly released: number;
}

/** A terminal sync failure surfaced after the retry policy was exhausted. */
export interface SyncFailure {
  readonly operation: "push" | "pull" | "pokes";
  readonly error: TransportError | StoreError | MutatorError;
}

/**
 * Options for {@link make}: the client and group ids, the mutator registry, and sync-loop tuning.
 */
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
  /**
   * Declared secondary-index fields per collection (issue #113): `eq`/`In`/
   * range predicates on these fields resolve via an in-memory index instead
   * of a full scan (`Client.make` derives this from the Node/Collection
   * registry's `indexes`). Unset means no declared indexes.
   */
  readonly indexes?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Auto-discover indexable fields from registered subsets' predicates (the
   * top-level `eq`/`In`/range conjuncts' fields) and index them, in addition
   * to any declared `indexes` — TanStack DB's `autoIndex: "eager"`. Defaults
   * to `false`: zero-config behaviour is identical to no indexing.
   */
  readonly autoIndex?: boolean;
  /**
   * Retention for terminal (acknowledged/rejected) entries in {@link
   * ClientEngine.mutationStates} (#116). Unset uses {@link
   * MutationState.DEFAULT_MAX_TERMINAL}.
   */
  readonly mutationStateRetention?: MutationState.RetentionOptions;
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

/**
 * The built secondary indexes (#113) and the counters that guard installing one (#339). Immutable:
 * every change makes a new value, so a build can compare the value it started from against the
 * current one inside a single `Ref.modify`.
 */
interface IndexState {
  /** The built index per collection; absent means not built yet (or nothing to index). */
  readonly built: ReadonlyMap<string, Index.CollectionIndex>;
  /**
   * Per collection, bumped by every confirmed-row write to it (built or not) and by a field-set
   * change, which makes any index built against the old set stale.
   */
  readonly generations: ReadonlyMap<string, number>;
  /** Bumped by a `Clear`, which touches every collection. */
  readonly clears: number;
}

/**
 * Whether no confirmed-row write or field-set change touching `collection` happened between two
 * states, so an index built from rows read in `from` is still current in `to` (#339).
 */
const indexUnchangedFor = (collection: string, from: IndexState, to: IndexState): boolean =>
  from.clears === to.clears &&
  (from.generations.get(collection) ?? 0) === (to.generations.get(collection) ?? 0);

/** Attempts an index build gets when confirmed-row writes keep racing it; then it full-scans (#339). */
const MAX_INDEX_BUILD_ATTEMPTS = 3;

/** One row of a fallthrough read (ADR-0025). */
export type ReadRow = ReadResponse["rows"][number];

/**
 * The client-side engine: the journal, the materialized view (confirmed rows plus the optimistic
 * overlay), subscriptions and the push/pull sync loop. Apps reach it through a `Client`.
 */
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
   * A keyed, reactive mutation-state map (#116) — TanStack Query's
   * `useMutationState` analogue: every journaled mutation's current lifecycle
   * state (`pending` → `acknowledged` | `rejected`), keyed by `mutationId`.
   * Seeded from the journal at boot (so a reload shows pending intents) and
   * folded forward as mutations are journaled and settled, regardless of
   * whether they were journaled via `mutate`, `mutateEncoded`, or
   * `mutateWithAck`. Emits the current map immediately, then on every change
   * ({@link SubscriptionRef.changes} semantics). Terminal entries are
   * retained only up to `mutationStateRetention` — the journal, not this map,
   * is the durable source of truth for pending mutations.
   */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;
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
   * Reactive window retargeting (#133): like {@link observe}, but returns a
   * {@link WindowObservation} whose `retarget` widens/advances the SAME open
   * observation's `limit`/`cursor` — reusing `LiveView`'s maintained order
   * instead of requiring a fresh `observe(widerSubset)` (a re-subscribe and a
   * rebuild from scratch). The Svelte `useConnection` "load more" paging hook
   * is the reference consumer. Scoped: the underlying change-hub subscription
   * is released (and `retarget` becomes inert) when the scope closes — pair
   * with `Effect.scoped` or a long-lived component scope, the same as
   * {@link runSync}.
   */
  readonly observeWindow: (
    subset: Subset.Subset
  ) => Effect.Effect<WindowObservation, StoreError | MutatorError, Scope.Scope>;
  /**
   * Row-level deltas of a subset's live window (#115): `enter`/`exit` mark
   * predicate/limit-boundary crossings, `update` a same-membership value
   * change, `move` a same-membership/same-value position change (#112's
   * stable position keys) — batched per view-step (one array per
   * {@link ViewChange} application, mirroring `observe`'s one-page-per-step).
   * A confirmed-row pull `Patch` and a plain local mutation (#109 tracks a
   * mutator's local handler directly onto the cached overlay and publishes
   * exactly what it did) both diff precisely; `Rebuild`/seq-gap collapse — a
   * pull racing a still-pending mutation, an unknown mutator, a `Clear` —
   * emit a `reset` marker + fresh `enter`s instead of a diff, since the
   * overlay could have shifted any row (the same conservative fallback
   * `observe`'s page already takes). `LiveView.put`/`del` already decide
   * predicate/window membership per row; this surfaces that decision instead
   * of discarding it and rescanning two pages.
   *
   * `enter`/`update`/`move` carry the row's stable `position` (a
   * `LiveView.PositionedRow`'s `FractionalIndex` key): a row repositioned by
   * a neighbor's insert/delete without its own value changing is no longer
   * indistinguishable from "unchanged" — it emits `move` with its new and
   * previous position, so a keyed-list consumer re-sorts without diffing
   * pages (`docs/observing-row-changes.md`).
   */
  readonly observeChanges: {
    <A>(
      subset: Subset.TypedSubset<A>,
      options?: ObserveChangesOptions
    ): Stream.Stream<ReadonlyArray<RowChange.RowChange<TypedRow<A>>>, StoreError | MutatorError>;
    (
      subset: Subset.Subset,
      options?: ObserveChangesOptions
    ): Stream.Stream<ReadonlyArray<RowChange.RowChange<LocalRow>>, StoreError | MutatorError>;
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
   * Live aggregate over a subset: emits now and after every local change.
   * For an unwindowed subset (no `limit`/`cursor`, the common case), the fold
   * is maintained incrementally from `Patch` row deltas rather than re-scanned
   * (#110); a windowed subset, or a change too large to diff (`Rebuild`),
   * refolds the subset from scratch. Deduped — a change that leaves the
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
   * Compact the unpushed tail of the journal (#117's pacing strategies:
   * debounce/throttle/coalesce drop a superseded entry) and **renumber the
   * survivors so the client's mutation ids stay contiguous** (#249): the
   * backends reject an id gap (ADR-0008), so a bare drop would leave the
   * journal undrainable. The survivors take consecutive ids, in order,
   * continuing from the last entry that may already have been sent (or from
   * the first pending id), and the id counter is rewound to match.
   *
   * Only ever touches entries no push has claimed: it does nothing while a
   * push is in flight, and never drops or renumbers an entry at or below the
   * store's sent watermark (every id any push attempt, successful or not,
   * has included). An entry a push may have sent keeps its id forever — the
   * hard boundary of ADR-0008's exactly-once contract. It is skipped rather
   * than waited for: a caller that cannot compact just leaves one extra,
   * still-contiguous entry that the push delivers.
   *
   * Runs under the journal lock, so it is atomic with respect to `mutate`
   * (an id being allocated is never renumbered under it) and to a push's
   * claim of the pending set. Returns what it did: the `dropped` ids and the
   * `renumbered` `{ from, to }` moves. A caller holding ids for entries it
   * did not drop must apply the moves (`Paced` does) — an id it kept may now
   * name a different entry. `mutateWithAck` deferreds and `mutationStates`
   * follow the moves automatically; a dropped entry's deferred is
   * interrupted.
   */
  readonly dropIfPending: (
    mutationIds: ReadonlyArray<number>
  ) => Effect.Effect<CompactionResult, StoreError>;
  /**
   * Adopt an identity, applying the boundary's transition rule (#212,
   * CONTEXT.md "Identity boundary") — the same rule the store applies on
   * open, so boot and runtime cannot disagree:
   *
   * - **Unchanged** — the same principal; the replica is untouched.
   * - **Upgrade** — {@link Identity.anonymous} → signed in: the warm replica,
   *   its subscriptions and its journal all survive. Public rows are a subset
   *   of what the new identity may read.
   * - **Reset** — every other change, sign-out included. Unpushed journal
   *   entries are quarantined under the **superseded** fingerprint; confirmed
   *   rows, the pull cookie, and every registered subscription are dropped.
   *
   * A quarantine already held under the adopted fingerprint is released back
   * into the journal on every transition, `Unchanged` included: re-signing in
   * is what makes that identity's own unpushed writes pushable again. No
   * transition ever *discards* a quarantine — see
   * {@link ClientEngine.discardQuarantine}.
   *
   * Does not wait for an in-flight push. Quarantining preserves mutation ids
   * exactly, so an entry that was already on the wire is at worst
   * acknowledged and skipped by the backend's exactly-once ledger when it is
   * released, never applied twice.
   */
  readonly reset: (identity: Identity.Fingerprint) => Effect.Effect<ResetOutcome, StoreError>;
  /** The fingerprint this replica is stamped with, if any (see {@link reset}). */
  readonly identity: Effect.Effect<Identity.Fingerprint | undefined, StoreError>;
  /** Fingerprints currently holding quarantined write intents. */
  readonly quarantines: Effect.Effect<ReadonlyArray<Identity.Fingerprint>, StoreError>;
  /** The entries quarantined under a fingerprint, in causal order. */
  readonly quarantinedMutations: (
    identity: Identity.Fingerprint
  ) => Effect.Effect<ReadonlyArray<Mutation>, StoreError>;
  /**
   * Destroy a quarantine. The **only** path that discards a superseded
   * identity's unpushed write intents, and deliberately an explicit call —
   * no reset and no boot triggers it. Holding a departed user's intents on
   * the device indefinitely is the deliberate trade the quarantine makes, so
   * an app that needs them gone has to say so.
   */
  readonly discardQuarantine: (identity: Identity.Fingerprint) => Effect.Effect<void, StoreError>;
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

/**
 * The {@link ClientEngine} service, for integrations that take the engine from context
 * (`JsonApiSync.start`).
 */
export const ClientEngine = Context.Service<ClientEngine>(
  "@thomasfosterau/legation-effect/ClientEngine"
);

/**
 * Build a {@link ClientEngine} over the `ClientStore` and `ClientTransport` in context; the engine
 * lives as long as the scope.
 */
export const make = (
  options: ClientEngineOptions
): Effect.Effect<ClientEngine, never, ClientStore | ClientTransport | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* ClientStore;
    const transport = yield* ClientTransport;
    // The keyed mutation-state map (#116), seeded from the journal so a
    // reload shows pending intents before any push/pull runs. A store read
    // failure here is not fatal to engine construction (mirrors
    // `sampleJournalDepth`'s tolerance elsewhere): the map starts empty and
    // catches up as mutations are journaled.
    const initialPending = yield* store.pendingMutations.pipe(
      Effect.catch(() => Effect.succeed<ReadonlyArray<Mutation>>([]))
    );
    // Entries journaled by an earlier session may already have been pushed (and
    // a store written before the sent watermark existed has no record of it),
    // so freeze them: paced compaction (#249) only ever renumbers entries this
    // session journaled itself.
    yield* freezePending(store).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "ClientEngine: could not freeze the persisted journal at boot; paced compaction may renumber entries an earlier session pushed",
          { error }
        )
      )
    );
    const mutationStates = yield* SubscriptionRef.make(MutationState.seed(initialPending));
    // #212: with the identity boundary on, the sync-protocol client identity
    // is scoped to the principal. It has to be: mutation ids are a per-client
    // sequence the backend requires to be contiguous (ADR-0008's exactly-once
    // ledger), so a second principal continuing the first's numbering pushes a
    // gap the backend rejects, and restarting it collides with ids the first
    // already had applied. A derived id gives each principal its own sequence
    // — and gives a returning principal back exactly the sequence they left,
    // so quarantined entries released later are still contiguous under the
    // client that authored them.
    //
    // Derived, not stored, so it survives a reload with no extra durable
    // state; and left exactly as configured when no identity is stamped, so
    // an app that does not use the boundary sees no change at all.
    const clientIdFor = (identity: Identity.Fingerprint | undefined): string =>
      identity === undefined
        ? options.clientId
        : `${options.clientId}#${Identity.keySegment(identity)}`;
    const clientIdRef = yield* Ref.make(
      clientIdFor(
        yield* store.getIdentity.pipe(
          Effect.catch(() => Effect.succeed<Identity.Fingerprint | undefined>(undefined))
        )
      )
    );
    const currentClientId: Effect.Effect<string> = Ref.get(clientIdRef);
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
    // Count of `push` calls currently between reading their pending snapshot
    // and settling it (ack/reject) — i.e. mutations that MAY already be in
    // flight to the backend. `dropIfPending` (#117) refuses to compact any
    // entry while this is nonzero: a pending id it cannot prove is still
    // untouched by a push is left alone rather than risked (ADR-0008's hard
    // boundary — never mutate or reorder a pushed entry). Retries re-read
    // `pendingMutations` fresh each attempt, so a drop between attempts is
    // always safe; a counter (not a flag) covers overlapping pushes.
    const pushInFlight = yield* Ref.make(0);
    // Emit a mutation-lifecycle event onto the unified hub as its tagged
    // variant; `mutationEvents` projects these four tags back to `phase`s.
    const emitEvent = (
      mutationId: number,
      phase: MutationEvent["phase"],
      reason?: string
    ): Effect.Effect<void> =>
      currentClientId.pipe(
        Effect.flatMap((clientId) => {
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
            case "dropped":
              return emitEngineEvent({ _tag: "MutationDropped", clientId, mutationId });
          }
        })
      );
    // Project the four mutation variants back to the #36 `MutationEvent` shape.
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
        case "MutationDropped":
          return { clientId: event.clientId, mutationId: event.mutationId, phase: "dropped" };
        default:
          return undefined;
      }
    };
    // Sample the journal-depth gauge from the current pending count. Called on
    // every append (a new pending mutation), acknowledge (a trim) and paced
    // compaction, so it uses the store's count, which reads no pending bodies
    // (#260), rather than loading the whole journal to take its length.
    const sampleJournalDepth: Effect.Effect<void> = store.pendingCount.pipe(
      Effect.flatMap((count) => Metric.update(Telemetry.journalDepth, count)),
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
    // Invalidation must serialize with the tracked-write path below (#109):
    // that path holds the permit for its whole read-modify-write of the
    // cache, so an invalidation racing it outside the lock could be clobbered
    // by a stale `Ref.set` once the tracked write finishes. Going through the
    // same semaphore makes "invalidate" and "read cache, mutate, write cache
    // back" mutually exclusive, so whichever runs first is fully visible to
    // the other. Callers inside a block that already holds the permit (the
    // tracked-write path's own failure fallback) must use `Ref.set` directly
    // to avoid deadlocking on the non-reentrant semaphore.
    const invalidateOverlay = Semaphore.withPermit(overlayLock, Ref.set(overlayCache, undefined));

    // The acknowledged-but-unpulled tail (#286, ADR-0008). A push trims the
    // entries the backend applied from the journal, so they are never sent
    // again, but parks them here, oldest first, so the overlay keeps showing
    // their effects until a pull's `lastMutationIds` covers them. That pull's
    // patch carries the effects, and the rebase reveals them in one change.
    // Process-local: a restart before that pull shows the confirmed rows until
    // it lands, as before this tail existed. Written only under `overlayLock`,
    // so the tail and the journal read together form one snapshot.
    const unpulled = yield* Ref.make<ReadonlyArray<Mutation>>([]);
    // The journal the overlay replays: the unpulled tail, then the pending
    // journal. The caller holds `overlayLock`.
    const overlayJournalLocked: Effect.Effect<ReadonlyArray<Mutation>, StoreError> = Effect.gen(
      function* () {
        const tail = yield* Ref.get(unpulled);
        return [...tail, ...(yield* store.pendingMutations)];
      }
    );
    // The same snapshot, for a caller that does not already hold the lock.
    const overlayJournal = Semaphore.withPermit(overlayLock, overlayJournalLocked);

    // Ensure `view` holds a live, mutable map for `collection`, seeding it
    // lazily from confirmed rows the first time it's touched. Shared by
    // `computeOverlay` (fresh materialization, replayed sequentially so no
    // collection is seeded twice) and the tracked-write path (incremental
    // mutation onto the persisted cache) — both agree on what "the
    // collection's rows" means, and once a collection is seeded into a
    // cache-backed `view` it stays seeded across calls.
    const ensureCollectionMap = (
      view: Map<string, Map<RowId, LocalRow>>,
      collection: string
    ): Effect.Effect<Map<RowId, LocalRow>, StoreError> =>
      Effect.gen(function* () {
        const existing = view.get(collection);
        if (existing !== undefined) return existing;
        const created = new Map<RowId, LocalRow>();
        for (const row of yield* store.listRows(collection)) {
          created.set(row.id, { id: row.id, value: row.value });
        }
        view.set(collection, created);
        return created;
      });

    // A `LocalWriter` over `view`'s per-collection maps: `put`/`del` mutate
    // in place (through `ensureCollectionMap`'s lazy seeding) and, when
    // given, report each write via `onPut`/`onDel` — the one seam
    // `replayMutations`' plain replay and `trackedWriter`'s op-recording
    // variant (#109) both build on, rather than duplicating the put/del/get
    // wiring.
    const viewWriter = (
      view: Map<string, Map<RowId, LocalRow>>,
      onPut?: (collection: string, id: RowId, value: unknown) => void,
      onDel?: (collection: string, id: RowId) => void
    ): LocalWriter => ({
      put: (collection, id, value) =>
        ensureCollectionMap(view, collection).pipe(
          Effect.map((rows) => {
            rows.set(id, { id, value });
            onPut?.(collection, id, value);
          })
        ),
      del: (collection, id) =>
        ensureCollectionMap(view, collection).pipe(
          Effect.map((rows) => {
            rows.delete(id);
            onDel?.(collection, id);
          })
        ),
      get: (collection, id) =>
        ensureCollectionMap(view, collection).pipe(Effect.map((rows) => rows.get(id)?.value)),
    });

    // Replay `mutations` (in journal order) onto `view`, mutating its
    // per-collection maps in place. Journal args are encoded (they survive
    // persistence and the wire), so decode before replay. Shared by
    // `computeOverlay` (replays every currently-pending mutation) and the
    // tracked-write cold-cache path (replays every *other* pending mutation
    // before applying the new one on top via `trackedWriter` — passing the
    // pre-append snapshot avoids replaying the new mutation twice, since by
    // the time that path runs it has already been appended to the store).
    const replayMutations = (
      view: Map<string, Map<RowId, LocalRow>>,
      mutations: ReadonlyArray<Mutation>
    ): Effect.Effect<void, StoreError | MutatorError> =>
      Effect.gen(function* () {
        const writer = viewWriter(view);
        for (const mutation of mutations) {
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
      });

    // Secondary field-value indexes over confirmed rows (issue #113).
    // `indexFields` is the declared-plus-auto-discovered field set per
    // collection; `indexState` holds the actual `Index.CollectionIndex`es,
    // built lazily from the store and kept current by `applyPatch`/`seed`
    // deltas. An absent `built` entry means "not built yet" (or the
    // collection has no indexed fields) — the next access rebuilds it.
    // `generations` guard that rebuild against writes racing it (#339).
    const indexFields = yield* Ref.make(
      new Map<string, Set<string>>(
        Object.entries(options.indexes ?? {}).map(([collection, fields]) => [
          collection,
          new Set(fields),
        ])
      )
    );
    const indexState = yield* Ref.make<IndexState>({
      built: new Map(),
      generations: new Map(),
      clears: 0,
    });

    // The fields a subset's `where` could narrow via an index: the top-level
    // (or top-level-`And`) `Compare`/`In` conjuncts' fields. Used only to
    // decide what `autoIndex` should index — never changes evaluation.
    const indexableFieldsOf = (where: PredicateModule.Predicate): ReadonlyArray<string> => {
      const conjuncts = where._tag === "And" ? where.predicates : [where];
      const fields: Array<string> = [];
      for (const conjunct of conjuncts) {
        // Mirrors `CollectionIndex.conjunctIds`: `IS NOT NULL` never narrows.
        if (
          conjunct._tag === "Compare" ||
          conjunct._tag === "In" ||
          (conjunct._tag === "IsNull" && conjunct.negated !== true)
        ) {
          fields.push(conjunct.field);
        }
      }
      return fields;
    };

    // Record a subset's indexable fields when `autoIndex` is on, widening
    // that collection's declared field set and invalidating its built index
    // so the next access rebuilds with the new field. No-op otherwise.
    const noteAutoIndexFields = (subset: Subset.Subset): Effect.Effect<void> => {
      if (!options.autoIndex) return Effect.void;
      const discovered = indexableFieldsOf(subset.where);
      if (discovered.length === 0) return Effect.void;
      return Ref.modify(indexFields, (map) => {
        const current = map.get(subset.collection) ?? new Set<string>();
        const grown = new Set(current);
        for (const field of discovered) grown.add(field);
        if (grown.size === current.size) return [false, map] as const;
        const next = new Map(map);
        next.set(subset.collection, grown);
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((grew) =>
          grew
            ? Ref.update(indexState, (state) => {
                const built = new Map(state.built);
                built.delete(subset.collection); // force a rebuild with the widened field set
                // An in-flight build over the old field set must not install (#339).
                const generations = new Map(state.generations);
                generations.set(subset.collection, (generations.get(subset.collection) ?? 0) + 1);
                return { built, generations, clears: state.clears };
              })
            : Effect.void
        )
      );
    };

    // (Re)build a collection's index from confirmed store rows if it isn't
    // already built for its current declared field set. `undefined` means
    // the collection has no indexed fields, or the build kept losing a race
    // to a write (#339) — the caller's cue to full-scan.
    //
    // The build reads rows, yields, then installs, and a write can land in
    // that window: `updateIndexes` skips a collection with no built index, so
    // the write would be missing from `fresh`. The generation is therefore read
    // BEFORE `listRows` and compared inside the install's `Ref.modify`: a write
    // that bumped it after the read discards `fresh` and the build is retried.
    // A write that landed before the read is already in the rows.
    //
    // Serialising the build on `overlayLock` (the lock `applyPull` holds across
    // its patch write) was rejected: it would queue every read and mutation
    // behind a full-collection `listRows`, and the lock is not reentrant, so a
    // caller that already holds it would deadlock. The generation check keeps
    // reads unblocked and needs no lock.
    const ensureIndexBuilt = (
      collection: string
    ): Effect.Effect<Index.CollectionIndex | undefined, StoreError> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < MAX_INDEX_BUILD_ATTEMPTS; attempt++) {
          const fields = (yield* Ref.get(indexFields)).get(collection);
          if (fields === undefined || fields.size === 0) return undefined;
          const before = yield* Ref.get(indexState);
          const existing = before.built.get(collection);
          if (existing !== undefined) return existing;
          const fresh = Index.empty(fields);
          Index.rebuild(fresh, yield* store.listRows(collection));
          const installed = yield* Ref.modify(indexState, (state) => {
            // Another build installed first; it is kept current like any built index.
            const current = state.built.get(collection);
            if (current !== undefined) return [current, state] as const;
            if (!indexUnchangedFor(collection, before, state)) return [undefined, state] as const;
            return [
              fresh,
              { ...state, built: new Map(state.built).set(collection, fresh) },
            ] as const;
          });
          if (installed !== undefined) return installed;
        }
        return undefined;
      });

    // Indexed evaluation is sound only while a collection's confirmed rows
    // equal its materialized view — i.e. no pending mutation's optimistic
    // overlay (or acknowledged-but-unpulled tail, #286) could have shifted it
    // (the index tracks confirmed rows only).
    // Scoped per-collection (#133): a pending mutation's touched collections
    // are already computed for the rebase path (`collectionsTouchedByMutations`,
    // #109's tracked-write machinery), so a mutation pending against
    // collection A no longer disables index acceleration for a query against
    // untouched collection B. An unscoped result (an unknown mutator,
    // undecodable args — same cases `collectionsTouchedByMutations`'
    // `undefined` already covers for scoped Rebuilds) conservatively falls
    // back to a full scan for every collection, same as before this change.
    const indexForCollection = (
      collection: string
    ): Effect.Effect<Index.CollectionIndex | undefined, StoreError> =>
      overlayJournal.pipe(
        Effect.flatMap((pending) => {
          if (pending.length === 0) return ensureIndexBuilt(collection);
          return collectionsTouchedByMutations(pending).pipe(
            Effect.flatMap((touched) =>
              touched !== undefined && !touched.has(collection)
                ? ensureIndexBuilt(collection)
                : Effect.succeed(undefined)
            )
          );
        })
      );

    // Apply confirmed-row deltas (patch ops / seeded rows) to already-built
    // indexes. A collection with no built index yet is left alone — it
    // rebuilds fully from the store (which already reflects these deltas) on
    // next access. Every touched collection's generation is bumped, built or
    // not, so a build that read the rows before this write discards its result
    // rather than installing a snapshot that lacks it (#339). The bump and the
    // `built` snapshot are one `Ref.modify`, so an install is ordered entirely
    // before or entirely after this write.
    const updateIndexes = (ops: ReadonlyArray<PatchOp>): Effect.Effect<void> => {
      if (ops.length === 0) return Effect.void;
      return Ref.modify(indexState, (state) => {
        let clears = state.clears;
        const generations = new Map(state.generations);
        for (const op of ops) {
          if (op._tag === "Clear") clears++;
          else generations.set(op.collection, (generations.get(op.collection) ?? 0) + 1);
        }
        return [state.built, { built: state.built, generations, clears }] as const;
      }).pipe(
        Effect.map((built) => {
          if (built.size === 0) return;
          for (const op of ops) {
            if (op._tag === "Clear") {
              for (const index of built.values()) Index.clear(index);
              continue;
            }
            const index = built.get(op.collection);
            if (index === undefined) continue;
            if (op._tag === "Put") Index.upsertRow(index, op.id, op.value);
            else Index.deleteRow(index, op.id);
          }
        })
      );
    };

    /** Confirmed rows + the overlay journal (unpulled tail, then pending) replayed on top. */
    const computeOverlay: Effect.Effect<
      Map<string, Map<RowId, LocalRow>>,
      StoreError | MutatorError
    > = Effect.gen(function* () {
      const view = new Map<string, Map<RowId, LocalRow>>();
      yield* replayMutations(view, yield* overlayJournalLocked);
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

    // Run a mutator's local handler directly onto `view` (mutating its
    // per-collection maps in place) while recording the `put`/`del` it
    // performs as `OverlayOp`s — the delta an observer folds via the same
    // `LiveView.put`/`del` machinery a confirmed-row `Patch` already uses
    // (#109). `get` reads through the same lazily-seeded collection maps as
    // `computeOverlay`'s writer, so a read-modify-write handler sees exactly
    // what a fresh replay would show it.
    const trackedWriter = (
      view: Map<string, Map<RowId, LocalRow>>,
      ops: Array<PatchOp | OverlayOp>
    ): LocalWriter =>
      viewWriter(
        view,
        (collection, id, value) => ops.push({ _tag: "Put", collection, id, value }),
        (collection, id) => ops.push({ _tag: "Del", collection, id })
      );

    // Apply a journaled mutation's local effects onto the cached overlay in
    // place instead of invalidating it (#109's core optimization): the
    // mutate path then costs one `trackedWriter` run over the rows it
    // touches, not a full journal replay. Must run under `overlayLock` — the
    // caller (`journal`) holds the permit for its whole body, so this
    // reads/mutates/writes the cache without racing `materialize`'s fill or
    // another mutation's tracked write. `journalBefore` is the overlay journal
    // snapshot from *before* this mutation was appended to the store — the
    // cold-cache fallback replays exactly that (not a fresh overlay journal,
    // which would already include this mutation by
    // the time this runs), so `trackedWriter` below applies this mutation's
    // effect exactly once rather than once from the replay and once more from
    // the tracked write. Falls back to a Rebuild scoped to the mutator's
    // touched collections (or the unscoped `REBUILD` when that can't be
    // determined either) when the handler is unknown, when materializing a
    // cold cache fails, or when the handler itself fails partway through —
    // every fallback drops the cache via a direct `Ref.set` (not
    // `invalidateOverlay`, which would deadlock re-acquiring this same
    // permit), so the next `materialize` recomputes from scratch, which
    // already includes this mutation since it is appended before this call.
    //
    // `base` is what the caller found under the lock it holds throughout
    // (#260): the warm cache itself, or, only when the cache was cold, the
    // journal snapshot to rebuild it from. Every write of the cache holds
    // `overlayLock`, so the cache the caller saw is the cache this runs on,
    // and a warm cache costs no journal read at all.
    const applyMutationToOverlayLocked = (
      mutator: string,
      decodedArgs: unknown,
      base: OverlayBase
    ): Effect.Effect<ViewChange> =>
      Effect.gen(function* () {
        const handler = options.mutators.handlers.get(mutator);
        if (handler === undefined) {
          yield* Ref.set(overlayCache, undefined);
          return REBUILD;
        }
        let view: Map<string, Map<RowId, LocalRow>>;
        if (base._tag === "Warm") {
          view = base.view;
        } else {
          const journalBefore = base.journalBefore;
          const filled = yield* Effect.exit(
            timedRebase(
              Effect.gen(function* () {
                const fresh = new Map<string, Map<RowId, LocalRow>>();
                yield* replayMutations(fresh, journalBefore);
                return fresh;
              })
            )
          );
          if (filled._tag === "Failure") {
            yield* Ref.set(overlayCache, undefined);
            return REBUILD;
          }
          view = filled.value;
        }
        const ops: Array<PatchOp | OverlayOp> = [];
        const ran = yield* Effect.exit(handler(decodedArgs, trackedWriter(view, ops)));
        if (ran._tag === "Failure") {
          yield* Ref.set(overlayCache, undefined);
          const touched = yield* collectionsTouchedBy(mutator, decodedArgs);
          return rebuildFor(touched);
        }
        yield* Ref.set(overlayCache, view);
        return { _tag: "Patch", ops };
      });

    // All local rows of a collection (confirmed + overlay) as an id-keyed
    // map, loading confirmed rows the overlay didn't already touch. Returning
    // the map (not a spread array) lets indexed evaluation look candidates up
    // directly — no extra O(n) copy on top of the O(n) this already pays to
    // seed the map from the store; aggregate consumers below spread it into
    // an array themselves.
    const collectionRows = (collection: string) =>
      materialize.pipe(Effect.flatMap((view) => ensureCollectionMap(view, collection)));

    // The aggregate reducers below fold over a plain array (unindexed —
    // aggregate initialization isn't wired to the secondary-index planner).
    const collectionRowsArray = (collection: string) =>
      collectionRows(collection).pipe(Effect.map((rows) => [...rows.values()]));

    const query = (subset: Subset.Subset) =>
      Effect.gen(function* () {
        yield* noteAutoIndexFields(subset);
        const rowsById = yield* collectionRows(subset.collection);
        const index = yield* indexForCollection(subset.collection);
        return Subset.applyIndexed(rowsById, subset, index);
      });

    // Route the whole patch through the store's batched bulk write, so a K-op
    // patch on a large collection costs K row-value writes + ~1 index rewrite
    // per touched collection — I/O scales with patch size, not collection size
    // (#47) — instead of one read-whole/rewrite-whole per op. Also maintains
    // the secondary field-value indexes (#113) from the same ops.
    const applyPatch = (ops: ReadonlyArray<PatchOp>): Effect.Effect<void, StoreError> =>
      store.applyRowOps(ops).pipe(Effect.tap(() => updateIndexes(ops)));

    // Resolve a `mutateWithAck` deferred for `id`, if one is registered, and
    // drop it from `acks`. A no-op for mutations journaled via `mutate` or
    // `mutateEncoded`, which never register one.
    const resolveAck = (id: number, outcome: MutationOutcome): Effect.Effect<void> =>
      Ref.get(acks).pipe(
        Effect.flatMap((map) => {
          const deferred = map.get(id);
          return deferred === undefined
            ? Effect.void
            : Deferred.succeed(deferred, outcome).pipe(Effect.asVoid);
        }),
        Effect.andThen(forgetAck(id))
      );

    // Fold every still-`"pending"` mutation state at or below `lastId` to
    // `"acknowledged"` (#116) — every journaled mutation, not just ones with a
    // registered `mutateWithAck` deferred — then resolve any deferred that IS
    // registered and emit one `acknowledged` event per newly-settled id.
    // States already settled (e.g. rejected by `settleRejected` moments
    // earlier in the same push) are skipped, so this stays idempotent.
    const settleApplied = (lastId: number): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          SubscriptionRef.modify(mutationStates, (map) => {
            const settledIds: Array<number> = [];
            for (const [id, state] of map) {
              if (id > lastId || state.phase !== "pending") continue;
              settledIds.push(id);
            }
            // Fold every transition first, evict once (#116's `HashMap`
            // rationale): retention's scan-and-sort is O(size), so evicting
            // per-id inside a K-mutation ack sweep would cost O(K * size).
            const next = MutationState.acknowledgedMany(
              map,
              settledIds,
              now,
              options.mutationStateRetention
            );
            return [settledIds, next] as const;
          })
        ),
        Effect.flatMap((settledIds) =>
          Effect.forEach(settledIds, (id) =>
            resolveAck(id, { _tag: "applied" }).pipe(Effect.andThen(emitEvent(id, "acknowledged")))
          )
        ),
        Effect.asVoid
      );

    // Fold one mutation's permanent rejection in (#116), resolve any
    // registered `mutateWithAck` deferred, and emit `rejected` — regardless of
    // whether it was journaled via `mutate`, `mutateEncoded`, or `mutateWithAck`.
    const rejectAck = (id: number, reason: string): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          SubscriptionRef.update(mutationStates, (map) =>
            MutationState.rejected(map, id, reason, now, options.mutationStateRetention)
          )
        ),
        Effect.andThen(resolveAck(id, { _tag: "rejected", reason })),
        Effect.andThen(emitEvent(id, "rejected", reason))
      );

    // Resolve deferreds for the mutations this client had permanently rejected.
    const settleRejected = (response: PushResponse): Effect.Effect<void> =>
      Effect.gen(function* () {
        const mine = yield* currentClientId;
        for (const entry of response.rejected ?? []) {
          if (entry.clientId !== mine) continue;
          yield* rejectAck(entry.mutationId, entry.reason);
        }
      });

    // Settle this client's own entries that a watermark covers as applied.
    const settleOwnApplied = (lastMutationIds: Readonly<Record<string, number>>) =>
      Effect.gen(function* () {
        const lastId = lastMutationIds[yield* currentClientId];
        if (lastId !== undefined) yield* settleApplied(lastId);
      });

    // Pull ack (ADR-0008). The pull's patch already carries the effects of
    // everything its `lastMutationIds` covers, so the acknowledged tail those
    // entries occupy is released here, under the same invalidation as the
    // journal trim (#286). The caller holds `overlayLock` for the whole of
    // `applyPull`, the patch write included: a read in between would see the
    // new rows with the tail still parked, and replay the tail over them.
    // Takes no lock itself (the lock is not reentrant).
    const acknowledgeLocked = (lastMutationIds: Readonly<Record<string, number>>) =>
      Effect.gen(function* () {
        for (const [clientId, upTo] of Object.entries(lastMutationIds)) {
          yield* store.acknowledge(clientId, upTo);
        }
        yield* settleOwnApplied(lastMutationIds);
        yield* Ref.update(unpulled, (tail) => tail.filter((m) => !isCoveredBy(lastMutationIds, m)));
        yield* Ref.set(overlayCache, undefined);
        yield* sampleJournalDepth; // the trim changed journal depth
      });

    // Push ack (ADR-0008, #286). The backend applied every journal entry the
    // response covers, so trim them from the journal, where they must never be
    // sent again, and park the applied ones at the end of the unpulled tail:
    // their effects stay overlaid until a pull reports them, so the view does
    // not revert in between. A permanently rejected entry was not applied, so
    // it leaves the overlay now. Returns those rejected entries for the caller
    // to reveal. Holds `overlayLock`, so the trim and the tail move together.
    const acknowledgePushed = (
      response: PushResponse
    ): Effect.Effect<ReadonlyArray<Mutation>, StoreError> =>
      Semaphore.withPermit(
        overlayLock,
        Effect.gen(function* () {
          const rejectedKeys = new Set(
            (response.rejected ?? []).map((entry) => `${entry.clientId}\u0000${entry.mutationId}`)
          );
          const isRejected = (m: Mutation) =>
            rejectedKeys.has(`${m.clientId}\u0000${m.mutationId}`);
          const covered = (yield* store.pendingMutations).filter((m) =>
            isCoveredBy(response.lastMutationIds, m)
          );
          for (const [clientId, upTo] of Object.entries(response.lastMutationIds)) {
            yield* store.acknowledge(clientId, upTo);
          }
          const tail = [...(yield* Ref.get(unpulled)), ...covered.filter((m) => !isRejected(m))];
          const released = Math.max(0, tail.length - UNPULLED_LIMIT);
          if (released > 0) {
            yield* Effect.logWarning(
              "ClientEngine: no pull reported the oldest acknowledged mutations within the unpulled limit; releasing their overlay early",
              { released, limit: UNPULLED_LIMIT }
            );
          }
          yield* Ref.set(unpulled, released > 0 ? tail.slice(released) : tail);
          yield* Ref.set(overlayCache, undefined);
          return covered.filter(isRejected);
        })
      );

    // #117 / #249: compact superseded, still-pending journal entries for
    // pacing strategies, then renumber the survivors so the ids the backend
    // sees stay contiguous (it rejects a gap, ADR-0008).
    //
    // Safety, in three layers. (1) Everything below runs under `overlayLock`,
    // the same lock `journal` holds while it allocates and appends an id and
    // `push` holds while it claims the pending set, so no id is ever
    // renumbered between being allocated and being appended, and a push can
    // never read a snapshot this call is about to renumber. (2) It refuses
    // outright while a push is in flight (`pushInFlight`). (3) The store only
    // drops or renumbers entries above its sent watermark, which `push` raises
    // (durably) before a request leaves — so an entry any attempt may have
    // put on the wire, even one that failed, keeps its id. The hard boundary
    // is enforced here and in the store, once, rather than trusted to callers.
    //
    // Everything keyed by an old id is moved in step, inside the lock: the
    // `mutateWithAck` deferreds (`acks`) and the `mutationStates` map. The
    // dropped entries' deferreds are interrupted (nothing will ever settle
    // them, and their ids may be reused). A global rebuild is the safe
    // fallback since the dropped mutations' collections aren't known without
    // re-decoding args already gone from the journal.
    const dropIfPending: ClientEngine["dropIfPending"] = (mutationIds) =>
      Effect.gen(function* () {
        if (mutationIds.length === 0) return NO_COMPACTION;
        const clientId = yield* currentClientId;
        // Uninterruptible from the store's commit to the last re-key (#249
        // review B1): the store has renumbered the journal by the time
        // `compactPending` returns, so an interrupt before the acks, states and
        // events catch up would leave this engine, Paced and every handle on
        // ids that no longer exist. Events and the cache invalidation run
        // inside the lock too, so no `mutate` can interleave a new id between
        // the renumbering and its announcement.
        return yield* Semaphore.withPermit(
          overlayLock,
          Effect.uninterruptible(
            Effect.gen(function* () {
              if ((yield* Ref.get(pushInFlight)) > 0) return NO_COMPACTION;
              const compaction = yield* store.compactPending(clientId, mutationIds);
              if (compaction.dropped.length === 0) return NO_COMPACTION;
              // Move the `mutateWithAck` deferreds: detach every old key first, so
              // a survivor landing on a slot a dropped entry vacated cannot clash.
              const orphans = yield* Ref.modify(acks, (map) => {
                const next = new Map(map);
                const dropped: Array<Deferred.Deferred<MutationOutcome>> = [];
                for (const id of compaction.dropped) {
                  const deferred = next.get(id);
                  if (deferred !== undefined) dropped.push(deferred);
                  next.delete(id);
                }
                const moved: Array<readonly [number, Deferred.Deferred<MutationOutcome>]> = [];
                for (const { from, to } of compaction.renumbered) {
                  const deferred = next.get(from);
                  if (deferred === undefined) continue;
                  moved.push([to, deferred]);
                  next.delete(from);
                }
                for (const [to, deferred] of moved) next.set(to, deferred);
                return [dropped, next] as const;
              });
              // Fold the drop and the moves into `mutationStates` (#116) — without
              // the drop, a compacted entry's state would never leave `"pending"`,
              // leaving a devtools journal panel showing a phantom in-flight
              // mutation forever.
              const settledAt = yield* Clock.currentTimeMillis;
              yield* SubscriptionRef.update(mutationStates, (map) =>
                MutationState.compacted(map, compaction, settledAt, options.mutationStateRetention)
              );
              yield* Effect.forEach(orphans, (deferred) => Deferred.interrupt(deferred), {
                discard: true,
              });
              yield* Effect.forEach(compaction.dropped, (id) => emitEvent(id, "dropped"), {
                discard: true,
              });
              yield* Effect.forEach(
                compaction.renumbered,
                ({ from, to }) =>
                  emitEngineEvent({
                    _tag: "MutationRenumbered",
                    clientId,
                    previousMutationId: from,
                    mutationId: to,
                  }),
                { discard: true }
              );
              // Inside the lock `invalidateOverlay` would deadlock on it; the
              // cache is only ever cleared by setting it empty.
              yield* Ref.set(overlayCache, undefined);
              yield* sampleJournalDepth;
              yield* publishChange(REBUILD);
              return compaction;
            })
          )
        );
      });

    // #212: the identity boundary at runtime. The transition rule itself
    // lives in `Identity`, so this and the store's open-time check are the
    // same decision applied at two moments — a sign-out mid-session and a
    // reload under a new session must not disagree about whether the replica
    // survives.
    //
    // On a `Reset` the order matters: quarantine the journal FIRST (nothing
    // is destroyed, and the entries leave the keyspace `push` reads), then
    // drop rows, the cookie and every registered subscription. The stamp is
    // written last, so an interrupted reset leaves the store stamped for the
    // superseded identity and the next open re-runs the whole transition
    // rather than trusting a half-applied one.
    const reset: ClientEngine["reset"] = (next) =>
      Effect.gen(function* () {
        const current = (yield* store.getIdentity) ?? Identity.unstamped;
        const transition = Identity.transitionOf(current, next);
        let quarantined = 0;
        if (transition === "Reset") {
          quarantined = yield* store.quarantinePending(current);
          // The unpulled tail's effects belong to the superseded identity's rows,
          // which are cleared just below, so the tail goes with them (#286).
          yield* Semaphore.withPermit(overlayLock, Ref.set(unpulled, []));
          yield* store.clearRows;
          yield* store.clearCookie;
          yield* Ref.set(subscriptions, []);
          yield* Ref.set(namedSubs, []);
          // Outcome deferreds were issued to the superseded identity's
          // session; that session is over and the backend will never settle
          // them here. Interrupt them so no `mutateWithAck` caller hangs —
          // the same treatment scope close gives them.
          yield* Ref.getAndSet(acks, new Map()).pipe(
            Effect.flatMap((map) => Effect.forEach([...map.values()], Deferred.interrupt))
          );
        }
        if (transition !== "Unchanged") {
          yield* store.setIdentity(next);
          // The scoped client identity moves with the stamp, so this
          // principal's mutations get their own contiguous id sequence (see
          // `clientIdFor`). Journal entries already written keep the client
          // id they were authored under, and push under it — each ledger
          // stays contiguous on its own.
          yield* Ref.set(clientIdRef, clientIdFor(next));
        }
        // Every branch, `Unchanged` included: re-signing in is what makes an
        // identity's own quarantined entries pushable again, and running it
        // unconditionally also closes the window where a reset was
        // interrupted between stamping and releasing.
        const released = yield* store.releaseQuarantine(next);
        if (transition === "Unchanged" && released === 0) {
          return { transition, quarantined: 0, released: 0 };
        }
        // The journal and the confirmed rows both moved: reseed the keyed
        // state map from what is actually pending now, drop the materialized
        // overlay, and reveal the whole thing with one unscoped rebuild.
        yield* SubscriptionRef.set(
          mutationStates,
          MutationState.seed(yield* store.pendingMutations)
        );
        yield* invalidateOverlay;
        yield* sampleJournalDepth;
        yield* publishChange(REBUILD);
        return {
          transition,
          ...(transition === "Reset" ? { quarantinedUnder: current } : {}),
          quarantined,
          released,
        };
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

    // Claim the pending set for one push (#249), atomically with respect to
    // `dropIfPending` and `journal` (all three hold `overlayLock`): read the
    // snapshot, count the push in flight, and durably raise the sent watermark
    // to the highest id per client in it — *before* the request can leave. A
    // failed or interrupted round trip does not prove the backend never
    // applied it, so from here on those ids are frozen: compaction may not
    // drop or renumber them. The counter is released on every path that does
    // not hand the claim to the push body.
    const claimPending: Effect.Effect<ReadonlyArray<Mutation>, StoreError> = Semaphore.withPermit(
      overlayLock,
      Effect.gen(function* () {
        const pending = yield* store.pendingMutations;
        if (pending.length === 0) return pending;
        const highest = new Map<string, number>();
        for (const m of pending) {
          if (m.mutationId > (highest.get(m.clientId) ?? 0)) highest.set(m.clientId, m.mutationId);
        }
        yield* Ref.update(pushInFlight, (n) => n + 1);
        yield* Effect.forEach(highest, ([clientId, upTo]) => store.markSent(clientId, upTo), {
          discard: true,
        }).pipe(Effect.onError(() => Ref.update(pushInFlight, (n) => n - 1)));
        return pending;
      })
    );

    const pushClaimed = (pending: ReadonlyArray<Mutation>) =>
      Effect.gen(function* () {
        yield* emitEngineEvent({ _tag: "PushStarted" });
        const response = yield* transport.push({
          clientGroupId: options.clientGroupId,
          mutations: pending,
          ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
        });
        // Settle permanently-rejected mutations before the ack sweep, so a
        // rejected id reports `rejected` rather than `applied`.
        yield* settleRejected(response);
        // The applied entries keep their overlay effects in the unpulled tail
        // until a pull reports them (#286), so the view does not change here.
        // Only a permanent rejection leaves the overlay now; reveal just those
        // collections.
        const rejected = yield* acknowledgePushed(response);
        yield* settleOwnApplied(response.lastMutationIds);
        yield* sampleJournalDepth; // the trim changed journal depth
        if (rejected.length > 0) {
          yield* publishChange(rebuildFor(yield* collectionsTouchedByMutations(rejected)));
        }
        yield* Metric.update(Telemetry.mutationsPushedTotal, pending.length);
        yield* Metric.update(Telemetry.pushesTotal, 1);
        yield* Metric.update(Telemetry.pushMutations, pending.length);
        yield* emitEngineEvent({ _tag: "PushCompleted", mutations: pending.length });
      });

    // The claim is held for the whole round trip (through the ack sweep) and
    // released on every exit path, including failure and interruption, so a
    // transient push error never wedges the counter.
    const push: ClientEngine["push"] = withVersionLatch(
      Effect.acquireUseRelease(
        claimPending,
        (pending) => (pending.length === 0 ? Effect.void : pushClaimed(pending)),
        (pending) => (pending.length === 0 ? Effect.void : Ref.update(pushInFlight, (n) => n - 1))
      )
    ).pipe(Effect.withSpan(Telemetry.span.clientPush));

    // The distinct collections and individual rows a pulled patch touches,
    // computed before the patch is applied so a `Clear` can stand for every
    // collection the client currently holds (the patch would otherwise wipe
    // them). Put/Del name their collection and row id directly; a `Clear` has
    // no finite row list, so it contributes to `collections` only. Drives
    // collection- and row-scoped reactions (HTTP-cache tag invalidation, #207)
    // via the `PullCompleted` event.
    interface PullTouched {
      readonly collections: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<{ readonly collection: string; readonly id: RowId }>;
    }
    const pullTouchedCollections = (
      patch: ReadonlyArray<PatchOp>
    ): Effect.Effect<PullTouched, StoreError> =>
      Effect.gen(function* () {
        const collections = new Set<string>();
        const rows: Array<{ readonly collection: string; readonly id: RowId }> = [];
        let cleared = false;
        for (const op of patch) {
          if (op._tag === "Clear") {
            cleared = true;
            continue;
          }
          collections.add(op.collection);
          rows.push({ collection: op.collection, id: op.id });
        }
        if (cleared) {
          for (const collection of yield* store.listCollections) collections.add(collection);
        }
        return { collections: [...collections], rows };
      });

    const applyPull = (response: PullResponse): Effect.Effect<PullTouched, StoreError> =>
      Effect.gen(function* () {
        // With an empty journal the patch ops are exactly the materialized-view
        // deltas, so observers maintain incrementally. With a pending overlay,
        // rebase (confirmed patch + replay of whatever mutations remain
        // pending, and the vanishing of whatever just got acknowledged or
        // rejected) could shift any row the patch or those pending-before-this-
        // pull mutations touch — scope a Rebuild to their union rather than
        // forcing a global one (#109's "stays a scoped Rebuild" rebase path);
        // a reset (`Clear`) still forces the unscoped fallback.
        const hasClear = response.patch.some((op) => op._tag === "Clear");
        const touched = yield* pullTouchedCollections(response.patch);
        // One critical section (#286): the overlay journal before this pull
        // (the unpulled tail, then pending), the confirmed-row write and the tail
        // release. A read that runs between the row write and the release would
        // otherwise see the new rows with the tail still replayed over them.
        // Reads and mutations wait on the store's patch write while the lock is
        // held (one IndexedDB transaction in the browser store). The section is
        // not failure-atomic: a store error after `applyPatch` leaves the rows
        // written and the tail unreleased, so the view double-counts until the
        // next successful pull.
        const journalBefore = yield* Semaphore.withPermit(
          overlayLock,
          Effect.gen(function* () {
            const before = yield* overlayJournalLocked;
            yield* applyPatch(response.patch);
            yield* acknowledgeLocked(response.lastMutationIds);
            return before;
          })
        );
        const hadPending = journalBefore.length > 0;
        yield* store.setCookie(response.cookie);
        let change: ViewChange;
        if (hasClear) {
          change = REBUILD;
        } else if (!hadPending) {
          change = { _tag: "Patch", ops: response.patch };
        } else {
          const mutationCollections = yield* collectionsTouchedByMutations(journalBefore);
          change = rebuildFor(
            mutationCollections === undefined
              ? undefined
              : new Set([...touched.collections, ...mutationCollections])
          );
        }
        // Atomic reveal: one change event after patch + ack (rebase is
        // recomputation in `materialize`).
        yield* publishChange(change);
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
        const touched = yield* applyPull(response);
        yield* Metric.update(Telemetry.pullsTotal, 1);
        yield* Metric.update(Telemetry.pullPatchOps, response.patch.length);
        yield* emitEngineEvent({
          _tag: "PullCompleted",
          ops: response.patch.length,
          collections: touched.collections,
          rows: touched.rows,
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
        yield* updateIndexes(
          rows.map((row): PatchOp => ({
            _tag: "Put",
            collection: row.collection,
            id: row.id,
            version: row.version,
            value: row.value,
          }))
        );
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
      // Subscribe to the push trigger here, before anything is forked (#317).
      // `Stream.fromPubSub` would subscribe only once the debounce's forked
      // upstream fibre first pulls, a few scheduler turns after this returns,
      // and a trigger published in between is lost; the connect leg below has
      // already read the journal by then, so that mutation would wait for
      // some unrelated push. Subscribing first leaves no gap: a mutation
      // journaled before this point is in the journal the connect leg reads,
      // and every later one queues a trigger on this subscription.
      const pushDebounce = options.syncLoop?.pushDebounce;
      const pushTriggers =
        pushDebounce === undefined ? undefined : yield* PubSub.subscribe(pushTrigger);
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
      if (pushDebounce !== undefined && pushTriggers !== undefined) {
        yield* Effect.forkScoped(
          Stream.fromSubscription(pushTriggers).pipe(
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
    // Apply a Patch's deltas for one collection to a LiveView — confirmed-row
    // ops from a pull, or optimistic `OverlayOp`s from a mutate (#109); both
    // shapes carry the `_tag`/`collection`/`id`/`value` this only reads.
    const applyOps = (
      view: LiveView.LiveView,
      collection: string,
      ops: ReadonlyArray<PatchOp | OverlayOp>
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

    // One sequenced step's page transition for a query's LiveView: `before`/
    // `after` are the window slices pre/post this step, `reset` marks a
    // Rebuild-touching-this-collection or a gap collapse — the overlay could
    // have shifted any row, so a consumer cannot diff `before` against
    // `after`. `observeSubset` always takes `after` (a scoped rebuild that
    // skips this collection returns `before === after`, so `changesWith`
    // dedups it); `observeSubsetChanges` diffs `before`/`after`, or emits a
    // `reset` batch when `reset` is set — the single seq/gap/rebuild-skip
    // decision both observers share, so they can never step out of sync with
    // each other. Mutates `viewRef`/`lastSeenRef` as a side effect.
    interface ViewStep {
      readonly before: ReadonlyArray<LocalRow>;
      readonly after: ReadonlyArray<LocalRow>;
      readonly reset: boolean;
    }
    // `readSubset` re-reads the *current* subset on every step rather than
    // closing over a fixed one, so a retargeted window (`observeWindow`
    // below) picks up its widened `limit`/advanced `cursor` on the very next
    // Rebuild/gap-collapse — `observeSubset`/`observeSubsetChanges` (whose
    // subset never changes) just pass `Effect.succeed(subset)`.
    const advanceView = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      lastSeenRef: Ref.Ref<number>,
      readSubset: Effect.Effect<Subset.Subset>,
      item: SeqChange
    ): Effect.Effect<ViewStep, StoreError | MutatorError> =>
      Effect.gen(function* () {
        const lastSeen = yield* Ref.get(lastSeenRef);
        if (item.seq <= lastSeen) {
          const page = LiveView.result(yield* Ref.get(viewRef));
          return { before: page, after: page, reset: false };
        }
        const subset = yield* readSubset;
        if (item.seq === lastSeen + 1) {
          yield* Ref.set(lastSeenRef, item.seq);
          const view = yield* Ref.get(viewRef);
          const before = LiveView.result(view);
          if (rebuildSkips(item.change, subset.collection)) {
            return { before, after: before, reset: false };
          }
          const isRebuild = item.change._tag === "Rebuild";
          const next = isRebuild
            ? LiveView.makeIndexed(
                subset,
                yield* collectionRows(subset.collection),
                yield* indexForCollection(subset.collection)
              )
            : applyOps(view, subset.collection, item.change.ops);
          if (next !== view) yield* Ref.set(viewRef, next);
          return { before, after: LiveView.result(next), reset: isRebuild };
        }
        // A drop happened before this seq: collapse it into a full Rebuild.
        // Read the latest assigned seq FIRST, then re-materialize — the store
        // then reflects every change with seq ≤ latest, so advancing
        // `lastSeenRef` to `latest` safely skips any still-buffered changes
        // already folded into this rebuild (they would otherwise re-apply as
        // stale, regressing rows). A Rebuild subsumes the dropped Patches
        // (ADR-0008), so the view is correct.
        yield* Metric.update(Telemetry.changeCollapsesTotal, 1);
        const before = LiveView.result(yield* Ref.get(viewRef));
        const latest = yield* Ref.get(changeSeq);
        const next = LiveView.makeIndexed(
          subset,
          yield* collectionRows(subset.collection),
          yield* indexForCollection(subset.collection)
        );
        yield* Ref.set(viewRef, next);
        yield* Ref.set(lastSeenRef, latest);
        return { before, after: LiveView.result(next), reset: true };
      });

    const stepView = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      lastSeenRef: Ref.Ref<number>,
      readSubset: Effect.Effect<Subset.Subset>,
      item: SeqChange
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError> =>
      advanceView(viewRef, lastSeenRef, readSubset, item).pipe(Effect.map((step) => step.after));

    const stepViewChanges = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      lastSeenRef: Ref.Ref<number>,
      readSubset: Effect.Effect<Subset.Subset>,
      item: SeqChange
    ): Effect.Effect<ReadonlyArray<RowChange.RowChange<LocalRow>>, StoreError | MutatorError> =>
      advanceView(viewRef, lastSeenRef, readSubset, item).pipe(
        Effect.map((step) =>
          step.reset ? RowChange.reset(step.after) : RowChange.diff(step.before, step.after)
        )
      );

    // Shared setup for `observeSubset`/`observeSubsetChanges`: establish the
    // live window a step at a time, so the two observers can never drift in
    // how they get there. Subscribe BEFORE snapshotting (#84): the hub only
    // delivers to live subscribers, so a change published while we
    // materialize must land in this subscription's buffer — subscribing
    // after the snapshot silently loses it, and with no later change to
    // reveal the seq gap the observer sleeps through the write forever. The
    // seq is captured before materializing so the view reflects the store at
    // ≥ that seq, making the first live change contiguous.
    const initSubsetView = (subset: Subset.Subset) =>
      Effect.gen(function* () {
        yield* noteAutoIndexFields(subset);
        const subscription = yield* PubSub.subscribe(changes);
        const startSeq = yield* Ref.get(changeSeq);
        const viewRef = yield* Ref.make(
          LiveView.makeIndexed(
            subset,
            yield* collectionRows(subset.collection),
            yield* indexForCollection(subset.collection)
          )
        );
        const lastSeenRef = yield* Ref.make(startSeq);
        return { subscription, viewRef, lastSeenRef };
      });

    const observeSubset = (subset: Subset.Subset) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { subscription, viewRef, lastSeenRef } = yield* initSubsetView(subset);
          const initial = LiveView.result(yield* Ref.get(viewRef));
          // Emit the page on each change, dropping re-emits when it didn't move
          // (e.g. a change outside the limit window, or a skipped stale seq).
          const readSubset = Effect.succeed(subset);
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((item) => stepView(viewRef, lastSeenRef, readSubset, item))
            )
          ).pipe(Stream.changesWith(sameResult));
        })
      );

    const observeSubsetChanges = (
      subset: Subset.Subset,
      changeOptions?: ObserveChangesOptions
    ): Stream.Stream<ReadonlyArray<RowChange.RowChange<LocalRow>>, StoreError | MutatorError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { subscription, viewRef, lastSeenRef } = yield* initSubsetView(subset);
          const initialRows = LiveView.result(yield* Ref.get(viewRef));
          // `includeInitial` emits the current window as `enter`s in its own
          // batch — no `reset` marker, since there is nothing to reset from.
          const initial: ReadonlyArray<ReadonlyArray<RowChange.RowChange<LocalRow>>> =
            changeOptions?.includeInitial === true && initialRows.length > 0
              ? [RowChange.enters(initialRows)]
              : [];
          const readSubset = Effect.succeed(subset);
          return Stream.concat(
            Stream.fromIterable(initial),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((item) => stepViewChanges(viewRef, lastSeenRef, readSubset, item)),
              Stream.filter((batch) => batch.length > 0)
            )
          );
        })
      );

    // Engine-level reactive window retargeting (#133): unlike `observeSubset`
    // (whose subset is fixed for the stream's lifetime), this tracks the
    // *current* subset in a `Ref` that `retarget` can widen/advance, and a
    // `retargetTick` that wakes the stream to reslice immediately — without
    // waiting for an unrelated engine change, and without the caller
    // resubscribing (`observe(widerSubset)`, which would rebuild `LiveView`
    // from scratch instead of reusing the maintained order).
    const observeWindow = (
      subset: Subset.Subset
    ): Effect.Effect<WindowObservation, StoreError | MutatorError, Scope.Scope> =>
      Effect.gen(function* () {
        const { subscription, viewRef, lastSeenRef } = yield* initSubsetView(subset);
        const subsetRef = yield* Ref.make(subset);
        const retargetTick = yield* SubscriptionRef.make(0);
        // Subscribe to the retarget tick NOW, not when `rows` is eventually
        // pulled (#84's "subscribe before snapshotting" discipline, applied
        // here too): `SubscriptionRef.changes` builds a lazily-subscribing
        // stream, so a `retarget()` call between `observeWindow` returning
        // and the caller actually consuming `rows` would otherwise publish
        // to a PubSub nobody is listening to yet and be silently missed.
        const retargetSubscription = yield* PubSub.subscribe(retargetTick.pubsub);
        const initial = LiveView.result(yield* Ref.get(viewRef));

        const retarget: WindowObservation["retarget"] = (window) =>
          Effect.gen(function* () {
            const previous = yield* Ref.get(subsetRef);
            const limit = window.limit !== undefined ? window.limit : previous.limit;
            const cursor = window.cursor !== undefined ? window.cursor : previous.cursor;
            if (limit === previous.limit && cursor === previous.cursor) return;
            const nextSubset: Subset.Subset = {
              ...previous,
              ...(limit !== undefined ? { limit } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
            };
            yield* Ref.set(subsetRef, nextSubset);
            yield* Ref.update(viewRef, (view) => LiveView.retarget(view, window));
            // Widen this observation's tracked subscription entry in place —
            // matched by the *previous* subset's hash, since limit/cursor are
            // part of what `Subset.hash` covers — so the next pull fetches the
            // wider window from the server too. A caller that never
            // `subscribe`d this exact subset has no server-tracked entry to
            // widen; the local reslice above still runs over whatever rows
            // are already synced.
            const previousHash = Subset.hash(previous);
            yield* Ref.update(subscriptions, (current) =>
              current.map((s) => (Subset.hash(s) === previousHash ? nextSubset : s))
            );
            yield* SubscriptionRef.update(retargetTick, (n) => n + 1);
          });

        const readSubset = Ref.get(subsetRef);
        const engineChanges = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((item) => stepView(viewRef, lastSeenRef, readSubset, item))
        );
        // The eager subscription above only ever delivers ticks published
        // *after* it was established — no replay of the seeded current
        // value (0) to skip, unlike `SubscriptionRef.changes`.
        const retargetChanges = Stream.fromSubscription(retargetSubscription).pipe(
          Stream.mapEffect(() => Ref.get(viewRef).pipe(Effect.map(LiveView.result)))
        );
        const rows = Stream.concat(
          Stream.succeed(initial),
          Stream.merge(engineChanges, retargetChanges)
        ).pipe(Stream.changesWith(sameResult));

        return { rows, retarget };
      });

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

    // Route a Patch's ops (this subset's collection only) through an
    // incremental aggregate state. A Patch's ops are confirmed-row deltas
    // from a pull, or optimistic `OverlayOp`s a mutate's local handler just
    // performed (#109) — both shapes carry the `_tag`/`collection`/`id`/`value`
    // this reads. `Put` carries the raw new value — `Aggregate.applyPut`
    // re-tests `subset.where` itself to decide insert/update/remove, exactly
    // as `applyOps` does for `LiveView` above.
    const applyAggregatePatch = (
      state: Aggregate.State,
      agg: Aggregate.Aggregate,
      subset: Subset.Subset,
      ops: ReadonlyArray<PatchOp | OverlayOp>
    ): Aggregate.State => {
      let next = state;
      for (const op of ops) {
        if (op._tag === "Clear" || op.collection !== subset.collection) continue;
        next =
          op._tag === "Put"
            ? Aggregate.applyPut(next, agg, subset.where, op.id, op.value)
            : Aggregate.applyDel(next, agg, op.id);
      }
      return next;
    };
    const applyAggregateGroupedPatch = (
      state: Aggregate.GroupedState,
      agg: Aggregate.Aggregate,
      subset: Subset.Subset,
      groupBy: string,
      ops: ReadonlyArray<PatchOp | OverlayOp>
    ): Aggregate.GroupedState => {
      let next = state;
      for (const op of ops) {
        if (op._tag === "Clear" || op.collection !== subset.collection) continue;
        next =
          op._tag === "Put"
            ? Aggregate.applyGroupedPut(next, agg, subset.where, groupBy, op.id, op.value)
            : Aggregate.applyGroupedDel(next, agg, op.id);
      }
      return next;
    };

    /**
     * A push-based reducer over a subset's raw row ops, feeding
     * {@link observeAggregateSubset}: `init` builds state from a full
     * collection scan (subscribe time, `Rebuild`, and gap-collapse), `applyOps`
     * folds a `Patch`'s row-level deltas in place, and `value`/`sameValue`
     * extract + dedupe the observable result.
     */
    interface AggregateReducer<S, V> {
      readonly init: (rows: ReadonlyArray<LocalRow>) => S;
      readonly applyOps: (state: S, ops: ReadonlyArray<PatchOp | OverlayOp>) => S;
      readonly value: (state: S) => V;
      readonly sameValue: (a: V, b: V) => boolean;
    }

    // Live aggregate over a subset's raw row ops: mirrors `observeSubset`'s
    // seq/gap-collapse handling, but folds a `reducer`'s state instead of
    // maintaining a `LiveView`. A `Patch` folds only the ops it carries, in
    // place; a `Rebuild` (or a seq-gap collapse) re-derives state from a full
    // collection scan, same as the page-observing path's `LiveView.make`.
    const observeAggregateSubset = <S, V>(
      subset: Subset.Subset,
      reducer: AggregateReducer<S, V>
    ): Stream.Stream<V, StoreError | MutatorError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const startSeq = yield* Ref.get(changeSeq);
          const stateRef = yield* Ref.make(
            reducer.init(yield* collectionRowsArray(subset.collection))
          );
          const lastSeenRef = yield* Ref.make(startSeq);
          const initial = reducer.value(yield* Ref.get(stateRef));

          const applyContiguousAgg = (
            change: ViewChange
          ): Effect.Effect<V, StoreError | MutatorError> =>
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef);
              if (rebuildSkips(change, subset.collection)) return reducer.value(state);
              const next =
                change._tag === "Rebuild"
                  ? reducer.init(yield* collectionRowsArray(subset.collection))
                  : reducer.applyOps(state, change.ops);
              yield* Ref.set(stateRef, next);
              return reducer.value(next);
            });

          const collapseAggregateToRebuild: Effect.Effect<V, StoreError | MutatorError> =
            Effect.gen(function* () {
              yield* Metric.update(Telemetry.changeCollapsesTotal, 1);
              const latest = yield* Ref.get(changeSeq);
              const next = reducer.init(yield* collectionRowsArray(subset.collection));
              yield* Ref.set(stateRef, next);
              yield* Ref.set(lastSeenRef, latest);
              return reducer.value(next);
            });

          const stepAggregateView = (
            item: SeqChange
          ): Effect.Effect<V, StoreError | MutatorError> =>
            Effect.gen(function* () {
              const lastSeen = yield* Ref.get(lastSeenRef);
              if (item.seq <= lastSeen) return reducer.value(yield* Ref.get(stateRef));
              if (item.seq === lastSeen + 1) {
                yield* Ref.set(lastSeenRef, item.seq);
                return yield* applyContiguousAgg(item.change);
              }
              return yield* collapseAggregateToRebuild;
            });

          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(stepAggregateView))
          ).pipe(Stream.changesWith(reducer.sameValue));
        })
      );

    const observeAggregate = (subset: Subset.Subset, agg: Aggregate.Aggregate) =>
      isWindowed(subset)
        ? Aggregate.observe(observeSubset(subset), agg)
        : observeAggregateSubset(subset, {
            init: (rows) => Aggregate.initState(agg, Subset.apply(rows, subset)),
            applyOps: (state, ops) => applyAggregatePatch(state, agg, subset, ops),
            value: Aggregate.stateValue,
            sameValue: Aggregate.sameValue,
          });
    const observeAggregateGrouped = (
      subset: Subset.Subset,
      agg: Aggregate.Aggregate,
      groupBy: string
    ) =>
      isWindowed(subset)
        ? Aggregate.observeGrouped(observeSubset(subset), agg, groupBy)
        : observeAggregateSubset(subset, {
            init: (rows) => Aggregate.initGroupedState(agg, Subset.apply(rows, subset), groupBy),
            applyOps: (state, ops) => applyAggregateGroupedPatch(state, agg, subset, groupBy, ops),
            value: Aggregate.groupedStateValue,
            sameValue: Aggregate.sameGroupedValue,
          });

    const invalidArgs = (mutator: string) => (cause: unknown) =>
      new MutatorError({ message: `Invalid args for mutator "${mutator}"`, mutator, cause });
    // Journal a mutation and reveal its local effects. The whole body runs
    // under `overlayLock` (#109): appending to the store then tracking the
    // handler's effects directly onto the cached overlay must be atomic with
    // respect to `materialize`'s fill and any other mutation's tracked write,
    // or a concurrent invalidation (push ack, pull, seed) could be clobbered
    // by this call's stale `Ref.set` once it finishes (see `invalidateOverlay`).
    const journal = (
      mutator: string,
      encoded: unknown,
      decodedArgs: unknown,
      outcome?: Deferred.Deferred<MutationOutcome>
    ) =>
      Semaphore.withPermit(
        overlayLock,
        Effect.gen(function* () {
          // Snapshot the journal *before* appending, so the tracked-write
          // fallback below replays exactly the mutations already pending —
          // not this one too (it is appended next, so `store.pendingMutations`
          // would otherwise double-count it: once from the replay, once from
          // `trackedWriter`). Only a cold overlay cache needs that replay: a
          // warm one already holds the pending set's effects, so the journal
          // (every pending body, on a durable store) is read only when the
          // cache is cold (#260). The lock held here keeps the cache as found
          // until `applyMutationToOverlayLocked` writes it.
          const cachedBefore = yield* Ref.get(overlayCache);
          const base: OverlayBase =
            cachedBefore === undefined
              ? { _tag: "Cold", journalBefore: yield* overlayJournalLocked }
              : { _tag: "Warm", view: cachedBefore };
          const clientId = yield* currentClientId;
          const journaledAt = yield* Clock.currentTimeMillis;
          // Allocate the id and append as one store step (#258): a refused or
          // failed append must not consume an id, or the next push hits a gap
          // the backends reject.
          const { mutationId } = yield* store.appendNext({
            clientId,
            mutator,
            args: encoded,
            createdAt: journaledAt,
          });
          // Register the `mutateWithAck` deferred before the lock is released:
          // a compaction (#249) also takes it, so the id cannot be renumbered
          // between being allocated and being keyed here.
          if (outcome !== undefined) {
            yield* Ref.update(acks, (map) => new Map(map).set(mutationId, outcome));
          }
          yield* sampleJournalDepth; // the append changed journal depth
          yield* SubscriptionRef.update(mutationStates, (map) =>
            MutationState.journaled(map, { mutationId, mutator, args: encoded, journaledAt })
          );
          yield* emitEvent(mutationId, "journaled");
          // Apply the handler's effects onto the cached overlay in place and
          // publish exactly what it did as a Patch, rather than invalidating
          // the cache and forcing every observer to re-materialize (#109).
          const change = yield* applyMutationToOverlayLocked(mutator, decodedArgs, base);
          yield* publishChange(change);
          yield* signalPush; // the sync loop may auto-push this (debounced)
          return mutationId;
        })
      );
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
          const deferred = yield* Deferred.make<MutationOutcome>();
          const mutationId = yield* journal(mutator, encoded, args, deferred);
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
      observeWindow,
      observeChanges: observeSubsetChanges as ClientEngine["observeChanges"],
      queryAggregate,
      queryAggregateGrouped,
      observeAggregate,
      observeAggregateGrouped,
      observeNamed: (name, args) =>
        Stream.unwrap(localSubsetOf(name, args).pipe(Effect.map(observeSubset))),
      push,
      pull,
      dropIfPending,
      reset,
      identity: store.getIdentity,
      quarantines: store.quarantines,
      quarantinedMutations: store.quarantinedMutations,
      discardQuarantine: store.discardQuarantine,
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
      // #116's keyed mutation-state map: current value now, then every change.
      mutationStates: SubscriptionRef.changes(mutationStates),
    });
  });

/** Layer building the engine from ClientStore + ClientTransport. */
export const layer = (
  options: ClientEngineOptions
): Layer.Layer<ClientEngine, never, ClientStore | ClientTransport> =>
  Layer.effect(ClientEngine)(make(options));
