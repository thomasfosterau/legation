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
 *    behind it still apply.
 * 2. `evaluate` returns the **current** (row id, row version) set for an
 *    authorized subset — versions change on every authoritative write.
 * 3. `getRows` returns encoded row values for explicit ids.
 *
 * `MemoryBackend.ts` is the reference implementation;
 * `BackendContract.verifyBackendContract` checks these guarantees against
 * any implementation.
 */

import { Context } from "effect";
import type { Effect } from "effect";
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

export interface ApplyResult {
  /** Highest applied (or permanently rejected) mutation id per client. */
  readonly lastMutationIds: Readonly<Record<string, number>>;
  readonly hints: ReadonlyArray<ChangeHint>;
  /**
   * Mutations acknowledged but permanently rejected (`MutationRejected`): their
   * id was bumped without applying effects. Omitted/empty when none were.
   */
  readonly rejected?: ReadonlyArray<RejectedMutation>;
}

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

export const Backend = Context.Service<Backend>("@legation/effect/Backend");
