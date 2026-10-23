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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  Backend,
  buildChangeHints,
  type ApplyResult,
  type RejectedMutation,
  type SyncContext,
} from "./Backend.js";
import { BackendError, MutationRejected } from "./Errors.js";
import type { Mutator } from "./Mutator.js";
import type { Mutation } from "./Protocol.js";
import * as Predicate from "./Predicate.js";
import * as RejectionMemory from "./RejectionMemory.js";
import * as Subset from "./Subset.js";
import * as UnknownMutator from "./UnknownMutator.js";

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

/** How one mutation's handler settled: its staged writes, or a permanent rejection. */
type Outcome =
  | { readonly _tag: "applied"; readonly log: ReadonlyArray<StagedEntry> }
  | { readonly _tag: "rejected"; readonly reason: string };

/**
 * How a copy of a mutation settled at commit: it committed its own outcome, an
 * earlier call had already committed this mutation (`rejection` is that call's
 * rejection reason, when it was rejected), or a row the handler read changed
 * first, so nothing was written and the handler must run again (#353).
 */
type Settlement =
  | { readonly _tag: "committed" }
  | { readonly _tag: "replayed"; readonly rejection: string | undefined }
  | { readonly _tag: "conflicted" };

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

const newStage = (): Stage => ({ log: [], overlay: new Map(), reads: new Map() });

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
  for (const [collection, ids] of reads) {
    const rows = s.rows.get(collection);
    for (const [id, seen] of ids) {
      if (rows?.get(id)?.version !== seen) return true;
    }
  }
  return false;
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
  for (const { collection, id, write } of log) {
    const collectionRows =
      working.get(collection) ?? new Map<string, MemoryRow>(s.rows.get(collection) ?? []);
    working.set(collection, collectionRows);
    if (write._tag === "put") {
      versionCounter += 1;
      collectionRows.set(id, { id, version: versionCounter, value: write.value });
    } else {
      collectionRows.delete(id);
    }
  }
  const rows = new Map(s.rows);
  for (const [collection, collectionRows] of working) rows.set(collection, collectionRows);
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
  for (const [collection, writes] of stage.overlay) {
    const ids = touched.get(collection) ?? new Set<string>();
    for (const [id, write] of writes) {
      ids.add(id);
      const values = puts.get(collection) ?? new Map<string, unknown>();
      if (write._tag === "put") {
        values.set(id, write.value);
      } else {
        values.delete(id);
      }
      puts.set(collection, values);
    }
    touched.set(collection, ids);
  }
};

/** Build a memory backend with the given authoritative handlers. */
export const make = (handlers: Readonly<Record<string, BackendHandler>>): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    // Commit one mutation's outcome and its bump in one state update, so
    // readers see both or neither. The client's committed watermark is
    // re-checked inside that update: a concurrent call may have committed this
    // mutation while its handler was running, and then this copy's outcome is
    // dropped (#346) and the committed one is reported instead (#355).
    //
    // The start-of-mutation gap rule needs no re-check here: it proved
    // `mutationId <= watermark + 1` when the mutation started, and the watermark
    // only rises, so the bound still holds at commit.
    //
    // The reads the handler made are re-checked here too (#353), after the
    // replay check and before any write. A changed read means nothing commits
    // and the caller runs the handler again. Because the check and the write are
    // one state update, no other group's commit can land between them.
    const commit = (
      context: SyncContext,
      mutation: Mutation,
      outcome: Outcome,
      reads: ReadSet
    ): Effect.Effect<Settlement> =>
      Ref.modify(state, (s): readonly [Settlement, MemoryState] => {
        if (lastIdOf(s, context.clientGroupId, mutation.clientId) >= mutation.mutationId) {
          const rejection = rejectionOf(
            s,
            context.clientGroupId,
            mutation.clientId,
            mutation.mutationId
          );
          return [{ _tag: "replayed", rejection }, s];
        }
        if (readsStale(s, reads)) return [{ _tag: "conflicted" }, s];
        const log = outcome._tag === "applied" ? outcome.log : [];
        const next = commitMutation(s, context, mutation, log);
        const committed =
          outcome._tag === "rejected"
            ? withRejection(
                next,
                context.clientGroupId,
                mutation.clientId,
                mutation.mutationId,
                outcome.reason
              )
            : next;
        return [{ _tag: "committed" }, committed] as const;
      });

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

    // Apply one mutation: skip replays, reject id gaps, then run the handler
    // against a stage. The stage and the lastMutationId bump commit in one
    // state update. A handler that succeeds commits its writes. A permanent
    // `MutationRejected` discards them and still bumps the id, so the poison
    // mutation is acknowledged, skipped, and cannot block the ones behind it.
    // A transient `BackendError` discards the stage and fails before any bump,
    // aborting the batch. A copy whose mutation a concurrent call committed
    // while its handler ran is dropped at commit, like a replay. Every replay
    // and dropped copy reports the committed rejection, if there is one (#355).
    // A handler whose reads went stale before its commit runs again, on a new
    // stage, until it commits, is dropped, or has run MAX_HANDLER_ATTEMPTS times
    // (#353). Past the cap it fails transiently, like a serialization failure on
    // PostgreSQL, so the client's retry takes over and nothing is written.
    interface Attempt {
      readonly stage: Stage;
      readonly outcome: Outcome;
      readonly settlement: Settlement;
    }
    const attempt = (
      context: SyncContext,
      mutation: Mutation,
      handle: BackendHandler,
      attempts = 1
    ): Effect.Effect<Attempt, BackendError> =>
      Effect.gen(function* () {
        const stage = newStage();
        const outcome: Outcome = yield* handle(mutation.args, stagingWriter(stage), context).pipe(
          Effect.map((): Outcome => ({ _tag: "applied", log: stage.log })),
          Effect.catchTag("MutationRejected", (error) =>
            Effect.succeed<Outcome>({ _tag: "rejected", reason: error.reason })
          )
        );
        const settlement = yield* commit(context, mutation, outcome, stage.reads);
        if (settlement._tag === "conflicted") {
          if (attempts >= MAX_HANDLER_ATTEMPTS) {
            return yield* new BackendError({
              message:
                `serialization conflict: mutation ${mutation.mutationId} of client ${mutation.clientId} ` +
                `read rows that changed before its commit on each of ${MAX_HANDLER_ATTEMPTS} attempts`,
            });
          }
          return yield* attempt(context, mutation, handle, attempts + 1);
        }
        return { stage, outcome, settlement };
      });

    const applyOne = (
      context: SyncContext,
      mutation: Mutation,
      touched: Map<string, Set<string>>,
      puts: Map<string, Map<string, unknown>>,
      rejected: Array<RejectedMutation>
    ): Effect.Effect<void, BackendError> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const last = (current.lastMutationIds.get(context.clientGroupId) ?? new Map()).get(
          mutation.clientId
        ) as number | undefined;
        const lastId = last ?? 0;
        if (mutation.mutationId <= lastId) {
          // Idempotent skip: no effects, but the committed rejection (if any).
          const reason = rejectionOf(
            current,
            context.clientGroupId,
            mutation.clientId,
            mutation.mutationId
          );
          if (reason !== undefined) {
            rejected.push({ clientId: mutation.clientId, mutationId: mutation.mutationId, reason });
          }
          return;
        }
        if (mutation.mutationId > lastId + 1) {
          return yield* new BackendError({
            message: `Mutation id gap for client ${mutation.clientId}: got ${mutation.mutationId}, expected ${lastId + 1}`,
          });
        }
        const handle = handlers[mutation.mutator];
        if (handle === undefined) {
          return yield* UnknownMutator.make(mutation.mutator);
        }

        const { stage, outcome, settlement } = yield* attempt(context, mutation, handle);
        if (settlement._tag === "replayed") {
          // A concurrent copy committed this mutation first: its stage, hints
          // and own outcome are dropped, as for a replay. The committed
          // rejection, if there was one, is reported so this response agrees
          // with the one that committed it (#355).
          if (settlement.rejection !== undefined) {
            rejected.push({
              clientId: mutation.clientId,
              mutationId: mutation.mutationId,
              reason: settlement.rejection,
            });
          }
          return;
        }
        if (outcome._tag === "applied") {
          foldStage(stage, touched, puts);
        } else {
          rejected.push({
            clientId: mutation.clientId,
            mutationId: mutation.mutationId,
            reason: outcome.reason,
          });
        }
      });

    const applyMutations = (
      context: SyncContext,
      mutations: ReadonlyArray<Mutation>
    ): Effect.Effect<ApplyResult, BackendError> =>
      Effect.gen(function* () {
        // The rejections below this push's floors are ones each client has
        // already seen the outcome of (#355).
        const floors = RejectionMemory.floorsOf(mutations);
        yield* Ref.update(state, (s) => forgetRejectionsBelow(s, context.clientGroupId, floors));

        // Pre-batch snapshot: the old values fine-grained fan-out derives
        // moved-away topics from (ADR-0023).
        const before = yield* Ref.get(state);
        const touched = new Map<string, Set<string>>();
        const puts = new Map<string, Map<string, unknown>>();
        const rejected: Array<RejectedMutation> = [];
        for (const mutation of mutations) {
          yield* applyOne(context, mutation, touched, puts, rejected);
        }
        const final = yield* Ref.get(state);
        const olds = new Map<string, Map<string, unknown>>();
        for (const [collection, ids] of touched) {
          const rows = before.rows.get(collection);
          if (rows === undefined) continue;
          const map = new Map<string, unknown>();
          for (const id of ids) {
            const row = rows.get(id);
            if (row !== undefined) map.set(id, row.value);
          }
          if (map.size > 0) olds.set(collection, map);
        }
        const hints = buildChangeHints(touched, puts, olds);
        return {
          lastMutationIds: Object.fromEntries(
            final.lastMutationIds.get(context.clientGroupId) ?? new Map()
          ),
          hints,
          ...(Arr.isReadonlyArrayNonEmpty(rejected) ? { rejected } : {}),
        };
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
          Effect.map((s) => {
            const result: Array<RejectedMutation> = [];
            for (const [clientId, ids] of s.rejections.get(context.clientGroupId) ?? new Map()) {
              for (const [mutationId, reason] of ids) result.push({ clientId, mutationId, reason });
            }
            return result;
          })
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
            for (const id of ids) {
              const row = collectionRows?.get(id);
              if (row !== undefined) result.push(row);
            }
            return result;
          })
        ),
    });
  });

/** Layer providing the memory backend. */
export const layer = (handlers: Readonly<Record<string, BackendHandler>>): Layer.Layer<Backend> =>
  Layer.effect(Backend)(make(handlers));
