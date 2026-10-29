/**
 * MemoryBackend
 *
 * The reference implementation of the Backend contract (ADR-0009): rows in
 * memory with a monotonic version counter, per-client lastMutationIds, and
 * app-supplied authoritative mutator handlers. Used in tests, demos, and
 * same-process sync rooms — and as the executable specification of the
 * contract's semantics (idempotent skip, gap rejection, atomic bump).
 *
 * Each mutation runs against a stage: its `put`/`del` writes are held in a
 * local overlay that its handler reads through, and nothing reaches the
 * committed rows until the handler returns. The staged writes and the
 * `lastMutationId` bump then commit in one state update, so a concurrent
 * `evaluate`, `getRows` or `lastMutationIds` sees both or neither. A
 * `BackendError` discards the stage and skips the bump.
 *
 * Concurrent `applyMutations` calls for one client group are safe (#346): the
 * commit re-checks the client's committed `lastMutationId`, so a copy of a
 * mutation that another call committed while its handler ran is dropped (its
 * stage discarded, reported as a replay skip), and the watermark only rises.
 *
 * Calls from different client groups are serialisable (#353). Every row a
 * handler reads from committed state is recorded with the version it had, and
 * the commit re-checks those versions inside the same state update that applies
 * the writes. A row another group changed since the read makes the commit
 * stale, so nothing is written and the handler runs again against the new
 * state. A counter read and incremented by two groups therefore loses no
 * increment. Reads of a handler's own staged writes are not recorded, since
 * those writes commit with the handler. A handler can run more than once, so
 * its effects outside the writer must be safe to repeat (see {@link BackendHandler}).
 * A handler still stale after a fixed number of runs fails with a transient
 * `BackendError` and writes nothing, so a hot row cannot loop it forever.
 *
 * Every copy reports the committed outcome (#355). A mutation committed as
 * permanently rejected is remembered with its reason, so a copy that loses the
 * race, or a later replay, lists it in `rejected` just as the copy that
 * committed it did. The client's outcome therefore does not depend on which
 * response arrives first. A remembered rejection is forgotten once the client's
 * next push starts past it (see {@link forgetRejectionsBelow}). The memory is
 * bounded per client: a client that never pushes again keeps its last push's
 * rejections. It assumes one journal per `clientId`, which backend contiguity
 * already requires.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  Backend,
  buildChangeHints,
  transaction,
  withoutTransaction,
  type Commit,
  type Opened,
  type Outcome,
  type RejectedMutation,
  type SyncContext,
} from "./Backend.js";
import { BackendError, MutationRejected } from "./Errors.js";
import type { Mutator } from "./Mutator.js";
import type { Mutation } from "./Protocol.js";
import * as Predicate from "./Predicate.js";
import * as RejectionMemory from "./RejectionMemory.js";
import * as Subset from "./Subset.js";

/**
 * The write surface handed to authoritative mutator handlers. Writes become
 * visible to other readers only when the mutation commits; `get` sees the
 * handler's own earlier writes.
 */
export interface BackendWriter {
  readonly put: (collection: string, id: string, value: unknown) => Effect.Effect<void>;
  readonly del: (collection: string, id: string) => Effect.Effect<void>;
  readonly get: (collection: string, id: string) => Effect.Effect<unknown | undefined>;
}

/**
 * An authoritative mutator handler. Fail with `BackendError` for a transient
 * error (aborts the batch, client retries) or `MutationRejected` for a
 * permanent one (id bumped without effects; the mutation is skipped). A handler
 * may run more than once when a row it read changed before its commit (#353),
 * so anything it does outside the writer must be safe to repeat.
 */
export type BackendHandler = (
  args: unknown,
  writer: BackendWriter,
  context: SyncContext
) => Effect.Effect<void, BackendError | MutationRejected>;

/** A mutator definition paired with its typed authoritative handler. */
export interface HandlerEntry<Args> {
  readonly mutator: Mutator<string, Args, any>;
  readonly handle: (
    args: Args,
    writer: BackendWriter,
    context: SyncContext
  ) => Effect.Effect<void, BackendError | MutationRejected>;
}

/** Pair a mutator definition with its authoritative handler (typed). */
export const handler = <Args>(
  mutator: Mutator<string, Args, any>,
  handle: HandlerEntry<Args>["handle"]
): HandlerEntry<Args> => ({ mutator, handle });

/**
 * Build the handler record from typed entries: pushed args are untrusted
 * input, so each handler schema-validates them (ADR-0008's "named,
 * schema-validated intent") before executing. Invalid args fail the push
 * with a BackendError.
 */
export const validatedHandlers = (
  entries: ReadonlyArray<HandlerEntry<any>>
): Record<string, BackendHandler> =>
  Object.fromEntries(
    entries.map(({ handle, mutator }) => [
      mutator.name,
      ((args, writer, context) =>
        Schema.decodeUnknownEffect(mutator.args)(args).pipe(
          Effect.mapError(
            (cause) =>
              new BackendError({
                message: `Invalid args for mutator "${mutator.name}"`,
                cause,
              })
          ),
          Effect.flatMap((decoded) => handle(decoded, writer, context))
        )) satisfies BackendHandler,
    ])
  );

interface MemoryRow {
  readonly id: string;
  readonly version: number;
  readonly value: unknown;
}

/**
 * How many times one mutation's handler runs while a row it read keeps changing
 * before its commit (#353). A handler still stale after this many runs fails
 * with a transient `BackendError` instead of looping on a hot row.
 */
const MAX_HANDLER_ATTEMPTS = 16;

interface MemoryState {
  readonly rows: ReadonlyMap<string, ReadonlyMap<string, MemoryRow>>;
  readonly versionCounter: number;
  /** clientGroupId → clientId → last applied mutation id. */
  readonly lastMutationIds: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * clientGroupId → clientId → mutationId → reason, for mutations committed as
   * permanently rejected and not yet forgotten (see {@link forgetRejectionsBelow}).
   */
  readonly rejections: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<number, string>>>;
}

const emptyState: MemoryState = {
  rows: new Map(),
  versionCounter: 0,
  lastMutationIds: new Map(),
  rejections: new Map(),
};

/** A write a handler made: a `put` of a value, or a `del`. */
type StagedWrite = { readonly _tag: "put"; readonly value: unknown } | { readonly _tag: "del" };

/** One staged write, tagged with the row it targets. */
interface StagedEntry {
  readonly collection: string;
  readonly id: string;
  readonly write: StagedWrite;
}

/**
 * The committed rows a handler read: for each row, the version it had at the
 * first read (`undefined` when the row was absent). The commit re-checks them.
 */
type ReadSet = Map<string, Map<string, number | undefined>>;

/**
 * A mutation's writes, not yet committed. `log` keeps them in handler order so
 * the commit assigns row versions exactly as an unstaged run would; `overlay`
 * keeps the latest write per row so the handler's reads see its own writes;
 * `reads` is what the handler saw in committed state (#353).
 */
interface Stage {
  readonly log: Array<StagedEntry>;
  readonly overlay: Map<string, Map<string, StagedWrite>>;
  readonly reads: ReadSet;
}

/** A fresh stage that records committed reads into `reads`. */
const newStage = (reads: ReadSet): Stage => ({ log: [], overlay: new Map(), reads });

const stageWrite = (stage: Stage, entry: StagedEntry): void => {
  stage.log.push(entry);
  const rowOverlay = stage.overlay.get(entry.collection) ?? new Map<string, StagedWrite>();
  rowOverlay.set(entry.id, entry.write);
  stage.overlay.set(entry.collection, rowOverlay);
};

/** Record the version a committed read saw; the first read of a row is the one checked. */
const recordRead = (
  stage: Stage,
  collection: string,
  id: string,
  version: number | undefined
): void => {
  const rows = stage.reads.get(collection) ?? new Map<string, number | undefined>();
  if (!rows.has(id)) rows.set(id, version);
  stage.reads.set(collection, rows);
};

/**
 * Whether a row the handler read has changed since: its committed version is no
 * longer the one it read. Versions only ever rise, so a row written again never
 * matches an old version, even if it was deleted in between.
 */
const readsStale = (s: MemoryState, reads: ReadSet): boolean => {
  return [...reads].some(([collection, ids]) => {
    const rows = s.rows.get(collection);
    return [...ids].some(([id, seen]) => rows?.get(id)?.version !== seen);
  });
};

/** The client's committed `lastMutationId` in a group; 0 before its first mutation. */
const lastIdOf = (s: MemoryState, clientGroupId: string, clientId: string): number =>
  s.lastMutationIds.get(clientGroupId)?.get(clientId) ?? 0;

/**
 * The state after one mutation commits: its `log` applied in order (each put
 * takes the next version) and the client's `lastMutationId` bumped. Pure, so
 * the caller can hand it to a single `Ref.modify`. The bump takes the max, so
 * the watermark never falls, even if a caller commits a lower id.
 */
const commitMutation = (
  s: MemoryState,
  context: SyncContext,
  mutation: Mutation,
  log: ReadonlyArray<StagedEntry>
): MemoryState => {
  const working = new Map<string, Map<string, MemoryRow>>();
  let versionCounter = s.versionCounter;
  Arr.forEach(log, ({ collection, id, write }) => {
    const collectionRows =
      working.get(collection) ?? new Map<string, MemoryRow>(s.rows.get(collection) ?? []);
    working.set(collection, collectionRows);
    if (write._tag === "put") {
      versionCounter += 1;
      collectionRows.set(id, { id, version: versionCounter, value: write.value });
    } else {
      collectionRows.delete(id);
    }
  });
  const rows = new Map(s.rows);
  Arr.forEach(working, ([collection, collectionRows]) => {
    rows.set(collection, collectionRows);
  });
  const lastIds = new Map(s.lastMutationIds);
  const groupIds = new Map(lastIds.get(context.clientGroupId) ?? []);
  groupIds.set(
    mutation.clientId,
    Math.max(lastIdOf(s, context.clientGroupId, mutation.clientId), mutation.mutationId)
  );
  lastIds.set(context.clientGroupId, groupIds);
  return { ...s, rows, versionCounter, lastMutationIds: lastIds };
};

/** The reason a mutation was committed as rejected, while that rejection is remembered. */
const rejectionOf = (
  s: MemoryState,
  clientGroupId: string,
  clientId: string,
  mutationId: number
): string | undefined => s.rejections.get(clientGroupId)?.get(clientId)?.get(mutationId);

/** The state with a permanent rejection of one mutation remembered (#355). */
const withRejection = (
  s: MemoryState,
  clientGroupId: string,
  clientId: string,
  mutationId: number,
  reason: string
): MemoryState => {
  const groups = new Map(s.rejections);
  const clients = new Map(groups.get(clientGroupId) ?? []);
  const ids = new Map(clients.get(clientId) ?? []);
  ids.set(mutationId, reason);
  clients.set(clientId, ids);
  groups.set(clientGroupId, clients);
  return { ...s, rejections: groups };
};

/**
 * Forget the rejections a client has moved past (#355). The rule, with its
 * floors, is {@link RejectionMemory.forgetBelow}.
 */
const forgetRejectionsBelow = (
  s: MemoryState,
  clientGroupId: string,
  floors: ReadonlyMap<string, number>
): MemoryState => {
  const clients = s.rejections.get(clientGroupId);
  if (clients === undefined) return s;
  const kept = RejectionMemory.forgetBelow(clients, floors);
  if (kept === clients) return s;
  const groups = new Map(s.rejections);
  if (kept.size === 0) groups.delete(clientGroupId);
  else groups.set(clientGroupId, kept);
  return { ...s, rejections: groups };
};

/**
 * The pre-batch values of the rows a batch touched, from the snapshot taken
 * before it (`before`): what topic-derived fan-out derives moved-away topics
 * from (ADR-0023). A row absent before the batch has no old value.
 */
const oldValuesOf = (
  before: MemoryState,
  touched: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, Map<string, unknown>> =>
  new Map(
    [...touched].flatMap(([collection, ids]) => {
      const rows = before.rows.get(collection);
      const values = new Map(
        [...ids].flatMap((id) => {
          const row = rows?.get(id);
          return row === undefined ? [] : [[id, row.value] as const];
        })
      );
      return values.size === 0 ? [] : [[collection, values] as const];
    })
  );

/**
 * Fold a committed stage into a batch's hint inputs: the ids it touched and
 * the values of its PUTs. A delete removes the id from the values, so it is
 * absent from what the hint emits, even when an earlier mutation of the same
 * batch put the row (#344): the hint describes the batch's final state, and a
 * row deleted later in the batch carries no value.
 */
const foldStage = (
  stage: Stage,
  touched: Map<string, Set<string>>,
  puts: Map<string, Map<string, unknown>>
): void => {
  Arr.forEach(stage.overlay, ([collection, writes]) => {
    const ids = touched.get(collection) ?? new Set<string>();
    Arr.forEach(writes, ([id, write]) => {
      ids.add(id);
      const values = puts.get(collection) ?? new Map<string, unknown>();
      if (write._tag === "put") {
        values.set(id, write.value);
      } else {
        values.delete(id);
      }
      puts.set(collection, values);
    });
    touched.set(collection, ids);
  });
};

/** One opened mutation: the context it runs in, and the committed rows its handler reads (#353). */
interface MemoryUnit {
  readonly context: SyncContext;
  readonly mutation: Mutation;
  readonly reads: ReadSet;
}

/** A push's state: its context and the rows before it, for hint old values (ADR-0023). */
interface MemoryBatch {
  readonly context: SyncContext;
  readonly before: MemoryState;
}

/**
 * Build a memory backend with the given authoritative handlers. Its
 * `applyMutations` is {@link transaction} over the memory store's steps, so the
 * ledger rules (order, skip, gap, the bump with each outcome, reporting) are
 * the combinator's (#177).
 */
export const make = (handlers: Readonly<Record<string, BackendHandler>>): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    // The writer a handler sees. Writes land in the mutation's stage, not in
    // `state`, so nothing is visible before the mutation commits. Reads check
    // the stage first, so the handler sees its own writes.
    const stagingWriter = (stage: Stage): BackendWriter => ({
      put: (collection, id, value) =>
        Effect.sync(() => stageWrite(stage, { collection, id, write: { _tag: "put", value } })),
      del: (collection, id) =>
        Effect.sync(() => stageWrite(stage, { collection, id, write: { _tag: "del" } })),
      get: (collection, id) => {
        const staged = stage.overlay.get(collection)?.get(id);
        if (staged !== undefined) {
          return Effect.succeed(staged._tag === "put" ? staged.value : undefined);
        }
        return Ref.get(state).pipe(
          Effect.map((s) => {
            const row = s.rows.get(collection)?.get(id);
            recordRead(stage, collection, id, row?.version);
            return row?.value;
          })
        );
      },
    });

    // Commit one mutation's outcome and its bump in one state update, so
    // readers see both or neither. The client's committed watermark is
    // re-checked inside that update: a concurrent call may have committed this
    // mutation while its handler was running, and then this copy's outcome is
    // dropped (#346) and the committed one is reported instead (#355).
    //
    // The start-of-mutation gap rule needs no re-check here: `open` proved
    // `mutationId = watermark + 1`, and the watermark only rises, so the bound
    // still holds at commit.
    //
    // The reads the handler made are re-checked here too (#353), after the
    // replay check and before any write. A changed read means nothing commits
    // and the combinator runs the handler again. Because the check and the
    // write are one state update, no other group's commit can land between them.
    // A rejected outcome carries no stage, so none of its writes can commit.
    const commit = (unit: MemoryUnit, outcome: Outcome<Stage>): Effect.Effect<Commit> =>
      Ref.modify(state, (s): readonly [Commit, MemoryState] => {
        const { context, mutation } = unit;
        if (lastIdOf(s, context.clientGroupId, mutation.clientId) >= mutation.mutationId) {
          const rejection = rejectionOf(
            s,
            context.clientGroupId,
            mutation.clientId,
            mutation.mutationId
          );
          return [{ _tag: "Replayed", rejection: Option.fromUndefinedOr(rejection) }, s];
        }
        if (readsStale(s, unit.reads)) return [{ _tag: "Conflicted" }, s];
        const log = outcome._tag === "Applied" ? outcome.staged.log : [];
        const next = commitMutation(s, context, mutation, log);
        const committed =
          outcome._tag === "Rejected"
            ? withRejection(
                next,
                context.clientGroupId,
                mutation.clientId,
                mutation.mutationId,
                outcome.reason
              )
            : next;
        return [{ _tag: "Committed" }, committed];
      });

    // A handler runs against a fresh stage each time it is opened, so a run
    // after a conflict (#353) starts from the committed state it now reads.
    // A handler still stale after `transaction`'s attempt cap fails
    // transiently, like a serialization failure on PostgreSQL.
    const applyMutations = transaction<BackendHandler, MemoryBatch, MemoryUnit, Stage>({
      handlers,
      atomically: withoutTransaction,
      maxAttempts: MAX_HANDLER_ATTEMPTS,
      begin: (context, floors) =>
        // The rejections below this push's floors are ones each client has
        // already seen the outcome of (#355). The snapshot after forgetting is
        // the pre-batch state hints take old values from (ADR-0023).
        Ref.update(state, (s) => forgetRejectionsBelow(s, context.clientGroupId, floors)).pipe(
          Effect.andThen(Ref.get(state)),
          Effect.map((before) => ({ context, before }))
        ),
      open: ({ context }, mutation) =>
        Ref.get(state).pipe(
          Effect.map((s): Opened<MemoryUnit> => {
            const last = lastIdOf(s, context.clientGroupId, mutation.clientId);
            return mutation.mutationId === last + 1
              ? { _tag: "Opened", unit: { context, mutation, reads: new Map() } }
              : {
                  _tag: "Watermark",
                  lastMutationId: last,
                  rejection: Option.fromUndefinedOr(
                    rejectionOf(s, context.clientGroupId, mutation.clientId, mutation.mutationId)
                  ),
                };
          })
        ),
      run: (unit, handle, mutation) => {
        const stage = newStage(unit.reads);
        return handle(mutation.args, stagingWriter(stage), unit.context).pipe(Effect.as(stage));
      },
      commit,
      // Opening moves nothing: the bump is part of the commit.
      release: () => Effect.void,
      finish: ({ context, before }, stages) =>
        Ref.get(state).pipe(
          Effect.map((final) => {
            const touched = new Map<string, Set<string>>();
            const puts = new Map<string, Map<string, unknown>>();
            Arr.forEach(stages, (stage) => foldStage(stage, touched, puts));
            return {
              lastMutationIds: Object.fromEntries(
                final.lastMutationIds.get(context.clientGroupId) ?? new Map()
              ),
              hints: buildChangeHints(touched, puts, oldValuesOf(before, touched)),
            };
          })
        ),
    });

    return Backend.of({
      applyMutations,
      lastMutationIds: (context) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            Object.fromEntries(s.lastMutationIds.get(context.clientGroupId) ?? new Map())
          )
        ),
      rejections: (context) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            [...(s.rejections.get(context.clientGroupId) ?? [])].flatMap(([clientId, ids]) =>
              [...ids].map(([mutationId, reason]): RejectedMutation => ({
                clientId,
                mutationId,
                reason,
              }))
            )
          )
        ),
      evaluate: (_context, subset) =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state);
          const collectionValues = (collection: string) =>
            [...(s.rows.get(collection) ?? new Map<string, MemoryRow>()).values()].map(
              (r) => r.value
            );
          // Resolve correlated Exists nodes against in-memory storage.
          const where = yield* Predicate.resolveExists(subset.where, (node) =>
            Effect.succeed(Predicate.existsValues(node, collectionValues(node.collection)))
          );
          const rows = [...(s.rows.get(subset.collection) ?? new Map()).values()];
          return Subset.apply(rows, { ...subset, where }).map((row) => ({
            id: row.id,
            version: row.version,
          }));
        }),
      getRows: (_context, collection, ids) =>
        Ref.get(state).pipe(
          Effect.map((s) => {
            const collectionRows = s.rows.get(collection);
            const result: Array<{ id: string; version: number; value: unknown }> = [];
            Arr.forEach(ids, (id) => {
              const row = collectionRows?.get(id);
              if (row !== undefined) result.push(row);
            });
            return result;
          })
        ),
    });
  });

/** Layer providing the memory backend. */
export const layer = (handlers: Readonly<Record<string, BackendHandler>>): Layer.Layer<Backend> =>
  Layer.effect(Backend)(make(handlers));
