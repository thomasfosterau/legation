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
 *    authorized subset — versions change on every authoritative write.
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

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RowId, RowVersion } from "./Collection.js";
import type { BackendError } from "./Errors.js";
import type { Mutation } from "./Protocol.js";
import type { Subset } from "./Subset.js";

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
    return { collection, ids: [...ids], values, ...(oldValues.length === 0 ? {} : { oldValues }) };
  });
