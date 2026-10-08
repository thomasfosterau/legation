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
 */

import { Effect, Layer, Ref, Schema } from "effect";
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
 * permanent one (id bumped without effects; the mutation is skipped).
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

interface MemoryState {
  readonly rows: ReadonlyMap<string, ReadonlyMap<string, MemoryRow>>;
  readonly versionCounter: number;
  /** clientGroupId → clientId → last applied mutation id. */
  readonly lastMutationIds: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

const emptyState: MemoryState = { rows: new Map(), versionCounter: 0, lastMutationIds: new Map() };

/** A write a handler made: a `put` of a value, or a `del`. */
type StagedWrite = { readonly _tag: "put"; readonly value: unknown } | { readonly _tag: "del" };

/** One staged write, tagged with the row it targets. */
interface StagedEntry {
  readonly collection: string;
  readonly id: string;
  readonly write: StagedWrite;
}

/**
 * A mutation's writes, not yet committed. `log` keeps them in handler order so
 * the commit assigns row versions exactly as an unstaged run would; `overlay`
 * keeps the latest write per row so the handler's reads see its own writes.
 */
interface Stage {
  readonly log: Array<StagedEntry>;
  readonly overlay: Map<string, Map<string, StagedWrite>>;
}

const newStage = (): Stage => ({ log: [], overlay: new Map() });

const stageWrite = (stage: Stage, entry: StagedEntry): void => {
  stage.log.push(entry);
  const rowOverlay = stage.overlay.get(entry.collection) ?? new Map<string, StagedWrite>();
  rowOverlay.set(entry.id, entry.write);
  stage.overlay.set(entry.collection, rowOverlay);
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

/**
 * Fold a committed stage into a batch's hint inputs: the ids it touched and
 * the values of its PUTs (a delete removes the id from the values, so it is
 * absent from what the hint emits).
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
      if (write._tag === "put") {
        const values = puts.get(collection) ?? new Map<string, unknown>();
        values.set(id, write.value);
        puts.set(collection, values);
      }
    }
    touched.set(collection, ids);
  }
};

/** Build a memory backend with the given authoritative handlers. */
export const make = (handlers: Readonly<Record<string, BackendHandler>>): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    // Commit one mutation's stage (empty for a rejection) and its bump in one
    // state update, so readers see both or neither. The client's committed
    // watermark is re-checked inside that update: a concurrent call may have
    // committed this mutation while its handler was running, and then this
    // copy's stage is dropped (#346). Returns whether it committed.
    //
    // The start-of-mutation gap rule needs no re-check here: it proved
    // `mutationId <= watermark + 1` when the mutation started, and the watermark
    // only rises, so the bound still holds at commit.
    const commit = (
      context: SyncContext,
      mutation: Mutation,
      log: ReadonlyArray<StagedEntry>
    ): Effect.Effect<boolean> =>
      Ref.modify(state, (s) => {
        if (lastIdOf(s, context.clientGroupId, mutation.clientId) >= mutation.mutationId) {
          return [false, s] as const;
        }
        return [true, commitMutation(s, context, mutation, log)] as const;
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
        return Ref.get(state).pipe(Effect.map((s) => s.rows.get(collection)?.get(id)?.value));
      },
    });

    // Apply one mutation: skip replays, reject id gaps, then run the handler
    // against a stage. The stage and the lastMutationId bump commit in one
    // state update. A handler that succeeds commits its writes. A permanent
    // `MutationRejected` discards them and still bumps the id, so the poison
    // mutation is acknowledged, skipped, and cannot block the ones behind it.
    // A transient `BackendError` discards the stage and fails before any bump,
    // aborting the batch. A copy whose mutation a concurrent call committed
    // while its handler ran is dropped at commit, like a replay.
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
        if (mutation.mutationId <= lastId) return; // idempotent skip
        if (mutation.mutationId > lastId + 1) {
          return yield* new BackendError({
            message: `Mutation id gap for client ${mutation.clientId}: got ${mutation.mutationId}, expected ${lastId + 1}`,
          });
        }
        const handle = handlers[mutation.mutator];
        if (handle === undefined) {
          return yield* new BackendError({ message: `Unknown mutator: ${mutation.mutator}` });
        }

        const stage = newStage();
        const outcome = yield* handle(mutation.args, stagingWriter(stage), context).pipe(
          Effect.map(() => ({ _tag: "applied" }) as const),
          Effect.catchTag("MutationRejected", (error) =>
            Effect.succeed({ _tag: "rejected", reason: error.reason } as const)
          )
        );
        const committed = yield* commit(
          context,
          mutation,
          outcome._tag === "applied" ? stage.log : []
        );
        // A concurrent copy committed this mutation first: a replay skip, so
        // its stage, its hints and any rejection are dropped, as for a replay.
        if (!committed) return;
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
          ...(rejected.length > 0 ? { rejected } : {}),
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
