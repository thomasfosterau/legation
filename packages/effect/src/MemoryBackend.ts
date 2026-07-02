/**
 * MemoryBackend
 *
 * The reference implementation of the Backend contract (ADR-0009): rows in
 * memory with a monotonic version counter, per-client lastMutationIds, and
 * app-supplied authoritative mutator handlers. Used in tests, demos, and
 * same-process sync rooms — and as the executable specification of the
 * contract's semantics (idempotent skip, gap rejection, atomic bump).
 */

import { Effect, Layer, Ref, Schema } from "effect";
import {
  Backend,
  type ApplyResult,
  type ChangeHint,
  type RejectedMutation,
  type SyncContext,
} from "./Backend.js";
import { BackendError, MutationRejected } from "./Errors.js";
import type { Mutator } from "./Mutator.js";
import type { Mutation } from "./Protocol.js";
import * as Predicate from "./Predicate.js";
import * as Subset from "./Subset.js";

/** The write surface handed to authoritative mutator handlers. */
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

/** Build a memory backend with the given authoritative handlers. */
export const make = (handlers: Readonly<Record<string, BackendHandler>>): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    const bumpLastId = (context: SyncContext, mutation: Mutation) =>
      Ref.update(state, (s) => {
        const lastIds = new Map(s.lastMutationIds);
        const groupIds = new Map(lastIds.get(context.clientGroupId) ?? []);
        groupIds.set(mutation.clientId, mutation.mutationId);
        lastIds.set(context.clientGroupId, groupIds);
        return { ...s, lastMutationIds: lastIds };
      });

    // A writer that records what it touches into `localTouched`, so a rejected
    // mutation's writes can be identified and rolled back.
    const stagingWriter = (localTouched: Map<string, Set<string>>): BackendWriter => ({
      put: (collection, id, value) =>
        Ref.update(state, (s) => {
          const rows = new Map(s.rows);
          const collectionRows = new Map(rows.get(collection) ?? []);
          const version = s.versionCounter + 1;
          collectionRows.set(id, { id, version, value });
          rows.set(collection, collectionRows);
          localTouched.set(collection, (localTouched.get(collection) ?? new Set()).add(id));
          return { ...s, rows, versionCounter: version };
        }),
      del: (collection, id) =>
        Ref.update(state, (s) => {
          const rows = new Map(s.rows);
          const collectionRows = new Map(rows.get(collection) ?? []);
          collectionRows.delete(id);
          rows.set(collection, collectionRows);
          localTouched.set(collection, (localTouched.get(collection) ?? new Set()).add(id));
          return { ...s, rows };
        }),
      get: (collection, id) =>
        Ref.get(state).pipe(Effect.map((s) => s.rows.get(collection)?.get(id)?.value)),
    });

    const mergeTouched = (into: Map<string, Set<string>>, from: Map<string, Set<string>>) => {
      for (const [collection, ids] of from) {
        const set = into.get(collection) ?? new Set<string>();
        for (const id of ids) set.add(id);
        into.set(collection, set);
      }
    };

    // Apply one mutation: skip replays, reject id gaps, then run the handler
    // atomically. Effects + the lastMutationId bump are atomic by construction
    // (single-threaded Ref updates). A transient `BackendError` aborts the batch
    // before any bump; a permanent `MutationRejected` rolls this mutation's
    // writes back (restore `current`, which predates them) yet still bumps the
    // id, so the poison mutation is acknowledged, skipped, and cannot block
    // the ones behind it.
    const applyOne = (
      context: SyncContext,
      mutation: Mutation,
      touched: Map<string, Set<string>>,
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

        const localTouched = new Map<string, Set<string>>();
        const outcome = yield* handle(mutation.args, stagingWriter(localTouched), context).pipe(
          Effect.map(() => ({ _tag: "applied" }) as const),
          Effect.catchTag("MutationRejected", (error) =>
            Ref.set(state, current).pipe(
              Effect.map(() => ({ _tag: "rejected", reason: error.reason }) as const)
            )
          )
        );
        if (outcome._tag === "applied") {
          mergeTouched(touched, localTouched);
        } else {
          rejected.push({
            clientId: mutation.clientId,
            mutationId: mutation.mutationId,
            reason: outcome.reason,
          });
        }
        yield* bumpLastId(context, mutation);
      });

    const applyMutations = (
      context: SyncContext,
      mutations: ReadonlyArray<Mutation>
    ): Effect.Effect<ApplyResult, BackendError> =>
      Effect.gen(function* () {
        const touched = new Map<string, Set<string>>();
        const rejected: Array<RejectedMutation> = [];
        for (const mutation of mutations) {
          yield* applyOne(context, mutation, touched, rejected);
        }
        const final = yield* Ref.get(state);
        const hints: Array<ChangeHint> = [...touched].map(([collection, ids]) => ({
          collection,
          ids: [...ids],
        }));
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
