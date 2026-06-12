/**
 * MemoryBackend
 *
 * The reference implementation of the Backend contract (ADR-0009): rows in
 * memory with a monotonic version counter, per-client lastMutationIds, and
 * app-supplied authoritative mutator handlers. Used in tests, demos, and
 * same-process sync rooms — and as the executable specification of the
 * contract's semantics (idempotent skip, gap rejection, atomic bump).
 */

import { Effect, Layer, Ref } from "effect";
import { Backend, type ApplyResult, type ChangeHint, type SyncContext } from "./Backend.js";
import { BackendError } from "./Errors.js";
import type { Mutation } from "./Protocol.js";
import * as Subset from "./Subset.js";

/** The write surface handed to authoritative mutator handlers. */
export interface BackendWriter {
  readonly put: (collection: string, id: string, value: unknown) => Effect.Effect<void>;
  readonly del: (collection: string, id: string) => Effect.Effect<void>;
  readonly get: (collection: string, id: string) => Effect.Effect<unknown | undefined>;
}

/** An authoritative mutator handler. */
export type BackendHandler = (
  args: unknown,
  writer: BackendWriter,
  context: SyncContext
) => Effect.Effect<void, BackendError>;

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

    const applyMutations = (
      context: SyncContext,
      mutations: ReadonlyArray<Mutation>
    ): Effect.Effect<ApplyResult, BackendError> =>
      Effect.gen(function* () {
        const touched = new Map<string, Set<string>>();

        for (const mutation of mutations) {
          const current = yield* Ref.get(state);
          const group = current.lastMutationIds.get(context.clientGroupId) ?? new Map();
          const last = group.get(mutation.clientId) ?? 0;
          if (mutation.mutationId <= last) continue; // idempotent skip
          if (mutation.mutationId > last + 1) {
            return yield* new BackendError({
              message: `Mutation id gap for client ${mutation.clientId}: got ${mutation.mutationId}, expected ${last + 1}`,
            });
          }
          const handler = handlers[mutation.mutator];
          if (handler === undefined) {
            return yield* new BackendError({ message: `Unknown mutator: ${mutation.mutator}` });
          }

          const writer: BackendWriter = {
            put: (collection, id, value) =>
              Ref.update(state, (s) => {
                const rows = new Map(s.rows);
                const collectionRows = new Map(rows.get(collection) ?? []);
                const version = s.versionCounter + 1;
                collectionRows.set(id, { id, version, value });
                rows.set(collection, collectionRows);
                touched.set(collection, (touched.get(collection) ?? new Set()).add(id));
                return { ...s, rows, versionCounter: version };
              }),
            del: (collection, id) =>
              Ref.update(state, (s) => {
                const rows = new Map(s.rows);
                const collectionRows = new Map(rows.get(collection) ?? []);
                collectionRows.delete(id);
                rows.set(collection, collectionRows);
                touched.set(collection, (touched.get(collection) ?? new Set()).add(id));
                return { ...s, rows };
              }),
            get: (collection, id) =>
              Ref.get(state).pipe(Effect.map((s) => s.rows.get(collection)?.get(id)?.value)),
          };

          // Handler effects + the lastMutationId bump are atomic here by
          // construction (single-threaded Ref updates, no partial commit on
          // failure because the handler error aborts before the bump is
          // recorded for subsequent mutations).
          yield* handler(mutation.args, writer, context);
          yield* Ref.update(state, (s) => {
            const lastIds = new Map(s.lastMutationIds);
            const groupIds = new Map(lastIds.get(context.clientGroupId) ?? []);
            groupIds.set(mutation.clientId, mutation.mutationId);
            lastIds.set(context.clientGroupId, groupIds);
            return { ...s, lastMutationIds: lastIds };
          });
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
        Ref.get(state).pipe(
          Effect.map((s) => {
            const rows = [...(s.rows.get(subset.collection) ?? new Map()).values()];
            return Subset.apply(rows, subset).map((row) => ({ id: row.id, version: row.version }));
          })
        ),
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
