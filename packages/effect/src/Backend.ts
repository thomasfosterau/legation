/**
 * Backend
 *
 * The BYO server contract (ADR-0009): the app owns canonical storage and
 * mutator execution; the library owns everything mechanical (CVR diffing,
 * patches, cookies, fan-out). An implementation must guarantee:
 *
 * 1. `applyMutations` executes each mutation's authoritative mutator
 *    transactionally, with the per-client `lastMutationId` bump atomic with
 *    the effects. Mutations with `mutationId <= lastMutationId` are skipped
 *    (idempotency); a gap (`> lastMutationId + 1`) is a `BackendError`. A
 *    handler that fails with `BackendError` aborts the batch (transient — the
 *    client retries); one that fails with `MutationRejected` is permanent — the
 *    id is bumped atomically *without* applying effects, so the mutation is
 *    acknowledged and skipped rather than poisoning the queue, and mutations
 *    behind it still apply. Calls for one client group may overlap (a retry
 *    while the first push is in flight): each mutation must still apply at most
 *    once, and `lastMutationId` must never move backwards, so a copy whose
 *    mutation a concurrent call already committed is skipped. Every copy
 *    reports the committed outcome (#355): a copy that is skipped, whether as
 *    a replay or because a concurrent call committed first, lists its mutation
 *    in `rejected` when that mutation was committed as rejected, with the same
 *    reason. So a client's outcome does not depend on which response reaches
 *    it first. A backend may forget a committed rejection once the client's
 *    next push starts past it, since a client resends only ids it has not had
 *    acknowledged.
 *
 *    Mutations from different client groups are serialisable (#353): the
 *    effects of all committed mutations are equivalent to some serial order,
 *    and a handler's reads see a state consistent with that order. So no
 *    committed write is lost to a concurrent call from another group that read
 *    the same row. A backend meets this with a store-wide lock, with a commit
 *    that re-checks each row the handler read and runs the handler again when
 *    one changed, or, on a database, with serialisable isolation. A backend may
 *    therefore run a handler more than once, so a handler's effects outside its
 *    writer must be safe to repeat. A backend that does not meet this does not
 *    conform to guarantee 1.
 * 2. `evaluate` returns the **current** (row id, row version) set for an
 *    authorized subset — versions change on every authoritative write. An
 *    optional `evaluateMany` evaluates several subsets at once (#505), so a
 *    backend can answer a pull's subsets in a bounded number of round trips;
 *    its result for each subset must equal `evaluate`'s for that subset, in
 *    the same order.
 * 3. `getRows` returns encoded row values for explicit ids.
 * 4. `rejections` lists the permanent rejections a client group still remembers,
 *    each with its reason (#365). A pull reports those its watermark covers, so
 *    a client whose push response was lost settles the rejection as rejected
 *    rather than applied. A rejection is remembered from the commit until a
 *    later push moves past it (guarantee 1), so it is listed for as long as a
 *    client could still need it.
 *
 * `MemoryBackend.ts` is the reference implementation;
 * `BackendContract.verifyBackendContract` checks these guarantees against
 * any implementation.
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { RowId, RowVersion } from "./Collection.js";
import { BackendError, type MutationRejected } from "./Errors.js";
import type { Mutation } from "./Protocol.js";
import * as RejectionMemory from "./RejectionMemory.js";
import type { Subset } from "./Subset.js";
import * as UnknownMutator from "./UnknownMutator.js";

/** Request-scoped context for authorization decisions. */
export interface SyncContext {
  readonly clientGroupId: string;
  /** App-defined identity (e.g. decoded token); never client-forgeable. */
  readonly identity?: unknown;
}

/** A change hint emitted after a committed push, for fan-out matching. */
export interface ChangeHint {
  readonly collection: string;
  readonly ids: ReadonlyArray<RowId>;
  /**
   * The current values of the rows PUT in this change, when the backend has
   * them cheaply to hand. Lets the server match hints against subscription
   * predicates instead of only their collection. Best-effort and additive: a
   * backend that can't produce values omits the field, and the server falls
   * back to a collection-level match. Deletes are ids present in `ids` but
   * absent from `values`; an omitted `values` means "no value information",
   * not "all deletes".
   */
  readonly values?: ReadonlyArray<{ readonly id: RowId; readonly value: unknown }> | undefined;
  /**
   * The pre-write values of the changed rows, when the backend has them
   * cheaply to hand (additive, like {@link values}). Old values let
   * topic-derived fan-out (ADR-0023) poke the windows a row **moved away
   * from** — an update that changes a foreign key derives both parents'
   * fine topics; a delete derives from the old row. Backends without them
   * degrade gracefully: moved-away windows converge on the interval pull.
   */
  readonly oldValues?: ReadonlyArray<{ readonly id: RowId; readonly value: unknown }> | undefined;
}

/** The (row id, row version) set an evaluated subset currently contains. */
export interface SubsetEntry {
  readonly id: RowId;
  readonly version: RowVersion;
}

/** A mutation the backend acknowledged but permanently rejected. */
export interface RejectedMutation {
  readonly clientId: string;
  readonly mutationId: number;
  readonly reason: string;
}

/**
 * What {@link Backend.applyMutations} reports: the new per-client mutation ids and change hints.
 */
export interface ApplyResult {
  /** Highest applied (or permanently rejected) mutation id per client. */
  readonly lastMutationIds: Readonly<Record<string, number>>;
  readonly hints: ReadonlyArray<ChangeHint>;
  /**
   * Mutations acknowledged but permanently rejected (`MutationRejected`): their
   * id was bumped without applying effects. Includes a rejected mutation a
   * replayed copy names (guarantee 1). Omitted/empty when none were.
   */
  readonly rejected?: ReadonlyArray<RejectedMutation>;
}

/**
 * The BYO server storage contract: apply mutations transactionally, evaluate an authorized
 * subset, fetch rows by id. The guarantees are in the module header.
 */
export interface Backend {
  readonly applyMutations: (
    context: SyncContext,
    mutations: ReadonlyArray<Mutation>
  ) => Effect.Effect<ApplyResult, BackendError>;

  /** Current per-client lastMutationIds for a group (used by pull). */
  readonly lastMutationIds: (
    context: SyncContext
  ) => Effect.Effect<Readonly<Record<string, number>>, BackendError>;

  /**
   * The permanent rejections the group's clients still remember, each with its
   * reason (guarantee 4). The sync server filters them by the pull's watermark
   * and returns them in the pull response (#365). Each entry's `mutationId` is
   * covered by its client's `lastMutationIds`, since a rejection is committed
   * with its id's bump.
   */
  readonly rejections: (
    context: SyncContext
  ) => Effect.Effect<ReadonlyArray<RejectedMutation>, BackendError>;

  /**
   * Evaluate an **already-authorized** subset (auth filters are AND-ed in
   * by the sync server before this call) to its current entries, in subset
   * order, respecting limit/cursor.
   */
  readonly evaluate: (
    context: SyncContext,
    subset: Subset
  ) => Effect.Effect<ReadonlyArray<SubsetEntry>, BackendError>;

  /**
   * Evaluate several **already-authorized** subsets at once (#505): one entry
   * list per subset, in the order of `subsets`, each equal to what
   * {@link Backend.evaluate} returns for that subset (guarantee 2). Optional:
   * a backend that can batch (one SQL statement for a pull's subsets) provides
   * it, and callers fall back to per-subset `evaluate` through
   * {@link evaluateAll} when it is absent. `BackendContract` checks the
   * equivalence on every backend that provides it.
   */
  readonly evaluateMany?:
    | ((
        context: SyncContext,
        subsets: ReadonlyArray<Subset>
      ) => Effect.Effect<ReadonlyArray<ReadonlyArray<SubsetEntry>>, BackendError>)
    | undefined;

  /** Fetch encoded row values for explicit ids. Missing ids are omitted. */
  readonly getRows: (
    context: SyncContext,
    collection: string,
    ids: ReadonlyArray<RowId>
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: RowId; readonly version: RowVersion; readonly value: unknown }>,
    BackendError
  >;
}

/**
 * Evaluate `subsets` to their entries, one list per subset in order: through
 * the backend's {@link Backend.evaluateMany} when it provides one, else one
 * {@link Backend.evaluate} per subset, in sequence. An empty `subsets` makes
 * no backend call, and an `evaluateMany` that returns a different number of
 * lists than it was given subsets fails with a `BackendError`.
 *
 * @example
 * ```ts
 * import { Backend, MemoryBackend } from "@thomasfosterau/legation-effect";
 * import { Subset } from "@thomasfosterau/legation-effect/internal";
 * import * as Effect from "effect/Effect";
 *
 * const program = Effect.gen(function* () {
 *   const backend = yield* MemoryBackend.make({});
 *   return yield* Backend.evaluateAll(backend, { clientGroupId: "g" }, [
 *     Subset.make({ collection: "todos" }),
 *   ]);
 * });
 * ```
 */
export const evaluateAll = (
  backend: Backend,
  context: SyncContext,
  subsets: ReadonlyArray<Subset>
): Effect.Effect<ReadonlyArray<ReadonlyArray<SubsetEntry>>, BackendError> => {
  if (Arr.isReadonlyArrayEmpty(subsets)) return Effect.succeed([]);
  const many = backend.evaluateMany;
  return many === undefined
    ? Effect.forEach(subsets, (subset) => backend.evaluate(context, subset), { concurrency: 1 })
    : many(context, subsets).pipe(
        Effect.filterOrFail(
          (lists) => lists.length === subsets.length,
          (lists) =>
            new BackendError({
              message: `evaluateMany returned ${lists.length} entry lists for ${subsets.length} subsets`,
            })
        )
      );
};

/** The {@link Backend} service the sync server reads and writes through. */
export const Backend = Context.Service<Backend>("@thomasfosterau/legation-effect/Backend");

/**
 * Build change hints from a push's touched ids and the values of its PUTs:
 * each touched collection becomes one hint whose `values` carry the current
 * row value of every PUT there. Ids touched but absent from `puts` are deletes,
 * so they appear in `ids` but not `values`. Backends that track writes as
 * `(touched, puts)` share this to emit predicate-matchable hints (ADR-0009).
 * Passing the pre-write rows (`olds`) additionally fills `oldValues`, which
 * topic-derived fan-out uses to poke moved-away edge windows (ADR-0023).
 */
export const buildChangeHints = (
  touched: ReadonlyMap<string, ReadonlySet<RowId>>,
  puts: ReadonlyMap<string, ReadonlyMap<RowId, unknown>>,
  olds?: ReadonlyMap<string, ReadonlyMap<RowId, unknown>>
): ReadonlyArray<ChangeHint> =>
  [...touched].map(([collection, ids]) => {
    const putMap = puts.get(collection);
    const oldMap = olds?.get(collection);
    const values = [...ids].flatMap((id) =>
      putMap?.has(id) === true ? [{ id, value: putMap.get(id) }] : []
    );
    const oldValues = [...ids].flatMap((id) =>
      oldMap?.has(id) === true ? [{ id, value: oldMap.get(id) }] : []
    );
    return {
      collection,
      ids: [...ids],
      values,
      ...(Arr.isReadonlyArrayEmpty(oldValues) ? {} : { oldValues }),
    };
  });

// ─── The transactional combinator (#177) ────────────────────────────────────

/**
 * What a store found when {@link transaction} asked it to open a pushed
 * mutation: the mutation is the client's next one and the store opened a unit
 * of work for it (`Opened`), or it is not, and the store reports the client's
 * committed watermark instead (`Watermark`), with the rejection it remembers
 * for the mutation's id when there is one. The combinator, not the store,
 * decides from a watermark whether the mutation is a replay or a gap.
 */
export type Opened<Unit> =
  | { readonly _tag: "Opened"; readonly unit: Unit }
  | {
      readonly _tag: "Watermark";
      readonly lastMutationId: number;
      readonly rejection: string | undefined;
    };

/**
 * What {@link transaction} asks a store to commit for one opened mutation,
 * together with the client's mutation-id bump. An applied mutation carries the
 * effects its handler staged; a rejected one carries only its reason, so the
 * combinator never hands a rejected mutation's effects to the store.
 */
export type Outcome<Staged> =
  | { readonly _tag: "Applied"; readonly staged: Staged }
  | { readonly _tag: "Rejected"; readonly reason: string };

/**
 * How a store's commit settled: it committed the outcome with the bump
 * (`Committed`), a concurrent call had already committed the mutation, whose
 * rejection reason it reports when there was one (`Replayed`), or a row the
 * handler read changed before the commit, so nothing was written and the
 * handler must run again (`Conflicted`, guarantee 1's serialisability).
 */
export type Commit =
  | { readonly _tag: "Committed" }
  | { readonly _tag: "Replayed"; readonly rejection: string | undefined }
  | { readonly _tag: "Conflicted" };

/**
 * The storage steps {@link transaction} composes into an `applyMutations`.
 * `Handler` is the store's app-handler type, `Batch` its per-push state, `Unit`
 * its per-mutation unit of work and `Staged` what a handler's run leaves to
 * commit.
 *
 * The store's obligations shrink to these: `commit` writes an applied
 * outcome's effects and the bump as one atomic step, and a rejected outcome's
 * bump and remembered rejection with none of the unit's effects; `atomically`,
 * when given, runs the whole push as one transaction. The ordering, skip, gap
 * and reporting rules are the combinator's.
 */
export interface TransactionSteps<Handler, Batch, Unit, Staged> {
  /** The app's authoritative handlers, by mutator name. A mutator without one is an `UnknownMutator` error. */
  readonly handlers: Readonly<Record<string, Handler>>;
  /**
   * Run the whole push inside the store's transaction (`SqlExecutor.transaction`).
   * Omitted, the steps run as they are, and each `commit` is the atomic unit.
   */
  readonly atomically?:
    | (<A>(
        context: SyncContext,
        effect: Effect.Effect<A, BackendError>
      ) => Effect.Effect<A, BackendError>)
    | undefined;
  /**
   * Start a push: forget the remembered rejections below `floors` (the push's
   * lowest id per client, `RejectionMemory.floorsOf`) and take whatever per-push
   * state the store needs (a snapshot for hint old values, a savepoint counter).
   */
  readonly begin: (
    context: SyncContext,
    floors: ReadonlyMap<string, number>
  ) => Effect.Effect<Batch, BackendError>;
  /**
   * Open the mutation's unit of work when it is its client's next one
   * (`mutationId` is the committed watermark plus one); otherwise report the
   * watermark. A store may move the watermark here (SQL's claim) as long as
   * the move is undone with the unit's effects.
   */
  readonly open: (batch: Batch, mutation: Mutation) => Effect.Effect<Opened<Unit>, BackendError>;
  /**
   * Run the app's handler for the mutation in the unit. Fails with
   * `MutationRejected` for a permanent rejection (the combinator commits it as
   * `Rejected`) or `BackendError` for a transient one (the push aborts).
   */
  readonly run: (
    unit: Unit,
    handler: Handler,
    mutation: Mutation
  ) => Effect.Effect<Staged, BackendError | MutationRejected>;
  /** Commit the outcome with the bump, atomically (see {@link TransactionSteps}). */
  readonly commit: (unit: Unit, outcome: Outcome<Staged>) => Effect.Effect<Commit, BackendError>;
  /**
   * Give a unit back after its handler failed transiently or named no handler:
   * undo anything `open` moved. Best effort; omitted, nothing is undone.
   */
  readonly release?: ((unit: Unit) => Effect.Effect<void>) | undefined;
  /** The push's result from what committed as applied, in push order. */
  readonly finish: (
    batch: Batch,
    applied: ReadonlyArray<Staged>
  ) => Effect.Effect<
    {
      readonly lastMutationIds: ApplyResult["lastMutationIds"];
      readonly hints: ApplyResult["hints"];
    },
    BackendError
  >;
  /**
   * How many times one mutation's handler runs while its commit keeps coming
   * back `Conflicted` before it fails transiently. Defaults to 16.
   */
  readonly maxAttempts?: number | undefined;
}

/** How one pushed mutation settled under {@link transaction}. */
type Settled<Staged> =
  | { readonly _tag: "Applied"; readonly staged: Staged }
  | { readonly _tag: "Reported"; readonly rejection: string | undefined };

/**
 * Build a backend's `applyMutations` from its storage steps (#177). The
 * combinator owns the ledger rules, so a backend built through it gets them by
 * construction rather than by convention:
 *
 * - **In order, exactly once** (`BackendContract` rules 1–3): mutations settle
 *   one at a time in push order; a mutation the watermark covers is skipped,
 *   reporting its committed rejection; one past the next expected id is a gap,
 *   a `BackendError`; a non-positive id is never new and opens nothing.
 * - **The bump travels with the outcome** (rules 4, 9 and 10): the only way a
 *   handler's effects reach `commit` is with the bump, a `MutationRejected` is
 *   committed as a bump with its reason and no effects, and a transient
 *   failure commits nothing and releases the unit.
 * - **Every copy reports the committed outcome** (#355): a replay or a copy a
 *   concurrent call committed first lists the committed rejection.
 *
 * What stays with the store, and with the runtime `BackendContract` suite: that
 * `commit` (or `atomically`) is really atomic and isolated, and everything
 * about evaluation (rule 6, settled by ADR-0028 and the differential harness).
 * Hand-assembled backends remain possible (ADR-0009); they get none of this
 * and must pass the suite on their own.
 *
 * @example
 * ```ts
 * import { Backend } from "@thomasfosterau/legation-effect";
 * import * as Effect from "effect/Effect";
 *
 * // A ledger-only store: handlers stage nothing, commits bump an in-memory watermark.
 * const ledger = new Map<string, number>();
 * const applyMutations = Backend.transaction({
 *   handlers: { "todo/noop": () => Effect.void },
 *   begin: (context) => Effect.succeed(context),
 *   open: (_context, mutation) => {
 *     const last = ledger.get(mutation.clientId) ?? 0;
 *     return Effect.succeed(
 *       mutation.mutationId === last + 1
 *         ? ({ _tag: "Opened", unit: mutation } as const)
 *         : ({ _tag: "Watermark", lastMutationId: last, rejection: undefined } as const)
 *     );
 *   },
 *   run: (_mutation, handler) => handler(),
 *   commit: (mutation) =>
 *     Effect.sync(() => {
 *       ledger.set(mutation.clientId, mutation.mutationId);
 *       return { _tag: "Committed" } as const;
 *     }),
 *   finish: () => Effect.sync(() => ({ lastMutationIds: Object.fromEntries(ledger), hints: [] })),
 * });
 *
 * const result = Effect.runSync(
 *   applyMutations({ clientGroupId: "g" }, [
 *     { clientId: "c", mutationId: 1, mutator: "todo/noop", args: {}, timestamp: 0 },
 *   ])
 * );
 * console.log(result.lastMutationIds); // { c: 1 }
 * ```
 */
export const transaction =
  <Handler, Batch, Unit, Staged>(
    steps: TransactionSteps<Handler, Batch, Unit, Staged>
  ): Backend["applyMutations"] =>
  (context, mutations) => {
    const maxAttempts = steps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const release = (unit: Unit): Effect.Effect<void> =>
      steps.release === undefined ? Effect.void : steps.release(unit);

    const settle = (
      batch: Batch,
      mutation: Mutation,
      attempt: number
    ): Effect.Effect<Settled<Staged>, BackendError> =>
      Effect.gen(function* () {
        const opened = yield* steps.open(batch, mutation);
        if (opened._tag === "Watermark") {
          if (mutation.mutationId <= opened.lastMutationId) {
            return { _tag: "Reported", rejection: opened.rejection } as const;
          }
          return yield* new BackendError({
            message:
              mutation.mutationId === opened.lastMutationId + 1
                ? `The store did not open mutation ${mutation.mutationId} of client ${mutation.clientId}, its next one`
                : `Mutation id gap for client ${mutation.clientId}: got ${mutation.mutationId}, expected ${opened.lastMutationId + 1}`,
          });
        }
        const unit = opened.unit;
        const handler = steps.handlers[mutation.mutator];
        if (handler === undefined) {
          yield* release(unit);
          return yield* UnknownMutator.make(mutation.mutator);
        }
        const outcome = yield* steps.run(unit, handler, mutation).pipe(
          Effect.map((staged): Outcome<Staged> => ({ _tag: "Applied", staged })),
          Effect.catchTag("MutationRejected", (error) =>
            Effect.succeed<Outcome<Staged>>({ _tag: "Rejected", reason: error.reason })
          ),
          Effect.onError(() => release(unit))
        );
        const committed = yield* steps.commit(unit, outcome);
        switch (committed._tag) {
          case "Conflicted": {
            if (attempt >= maxAttempts) {
              return yield* new BackendError({
                message:
                  `serialization conflict: mutation ${mutation.mutationId} of client ${mutation.clientId} ` +
                  `read rows that changed before its commit on each of ${maxAttempts} attempts`,
              });
            }
            return yield* settle(batch, mutation, attempt + 1);
          }
          case "Replayed":
            return { _tag: "Reported", rejection: committed.rejection } as const;
          case "Committed":
            return outcome._tag === "Applied"
              ? ({ _tag: "Applied", staged: outcome.staged } as const)
              : ({ _tag: "Reported", rejection: outcome.reason } as const);
        }
      });

    const push = Effect.gen(function* () {
      const batch = yield* steps.begin(context, RejectionMemory.floorsOf(mutations));
      // Ids start at 1 and a watermark at 0, so a non-positive id is never new:
      // it opens nothing.
      const settled = yield* Effect.forEach(
        mutations.filter((mutation) => mutation.mutationId > 0),
        (mutation) =>
          settle(batch, mutation, 1).pipe(Effect.map((outcome) => ({ mutation, outcome }))),
        { concurrency: 1 }
      );
      const applied = settled.flatMap(({ outcome }) =>
        outcome._tag === "Applied" ? [outcome.staged] : []
      );
      const rejected = settled.flatMap(({ mutation, outcome }): Array<RejectedMutation> =>
        outcome._tag === "Reported" && outcome.rejection !== undefined
          ? [
              {
                clientId: mutation.clientId,
                mutationId: mutation.mutationId,
                reason: outcome.rejection,
              },
            ]
          : []
      );
      const { lastMutationIds, hints } = yield* steps.finish(batch, applied);
      return {
        lastMutationIds,
        hints,
        ...(Arr.isReadonlyArrayNonEmpty(rejected) ? { rejected } : {}),
      } satisfies ApplyResult;
    });
    return steps.atomically === undefined ? push : steps.atomically(context, push);
  };

/** The default for {@link TransactionSteps.maxAttempts}. */
const DEFAULT_MAX_ATTEMPTS = 16;
