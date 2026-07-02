/**
 * SqlBackend
 *
 * A reference implementation of the core `Backend` contract (ADR-0009) over a
 * SQL database, addressing the audit's "turnkey backend" gap with a
 * driver-agnostic adapter: the app provides a tiny `SqlExecutor` (wrapping
 * `bun:sqlite`, `effect/unstable/sql`, `pg`, …) and per-collection table
 * mappings, and this backend supplies subset evaluation, row fetching, and the
 * transactional mutation-id ledger.
 *
 * Reads go through the `Sql` translator (`Subset` predicate → `WHERE`), then
 * `Subset.apply` finalizes order/limit/cursor locally (the `WHERE` is a sound
 * superset). Writes run app-provided handlers inside one transaction with the
 * per-client `lastMutationId` bump — the contract's exactly-once, in-order,
 * atomic guarantee, delegated to the database.
 */

import { Effect, Schema } from "effect";
import {
  Backend,
  BackendError,
  Hash,
  MutationRejected,
  Predicate,
  Subset,
  type Mutator,
} from "@legation/effect";
import * as Sql from "./Sql.js";

// Decode pushed args against the mutator's schema (untrusted input).
const decodeArgs = (
  definition: Mutator.AnyMutator,
  args: unknown,
  name: string
): Effect.Effect<unknown, BackendError> =>
  Schema.decodeUnknownEffect(definition.args)(args).pipe(
    Effect.mapError(
      (cause) => new BackendError({ message: `Invalid args for mutator "${name}"`, cause })
    )
  );

/** A row as returned by the driver: a column → value record. */
export type SqlRow = Record<string, unknown>;

/** The minimal database surface the backend needs. */
export interface SqlExecutor {
  /** Run a query and return its rows. */
  readonly query: (fragment: Sql.SqlFragment) => Effect.Effect<ReadonlyArray<SqlRow>, BackendError>;
  /** Run a statement for its effect (insert/update/delete). */
  readonly run: (fragment: Sql.SqlFragment) => Effect.Effect<void, BackendError>;
  /** Run an effect inside a transaction (atomic commit / rollback on error). */
  readonly transaction: <A, R>(
    effect: Effect.Effect<A, BackendError, R>
  ) => Effect.Effect<A, BackendError, R>;
}

/** How a collection maps onto a table. */
export interface TableMapping {
  readonly table: string;
  /** Primary-key column. Defaults to `"id"`. */
  readonly idColumn?: string;
  /** Column holding the row version; if absent, a content hash is used. */
  readonly versionColumn?: string;
}

/**
 * An app-authored write, running its own SQL inside the push transaction. Fail
 * with `BackendError` for a transient error (aborts the whole push) or
 * `MutationRejected` for a permanent one (this mutation's writes are rolled back
 * to a savepoint, its id still bumped, the batch continues).
 */
export type SqlHandler = (
  args: unknown,
  tx: SqlExecutor,
  context: Backend.SyncContext
) => Effect.Effect<ReadonlyArray<Backend.ChangeHint>, BackendError | MutationRejected>;

export interface SqlBackendConfig {
  readonly executor: SqlExecutor;
  readonly tables: Readonly<Record<string, TableMapping>>;
  /** Mutator definitions, for decoding/validating pushed args. */
  readonly mutators: ReadonlyMap<string, Mutator.AnyMutator>;
  readonly handlers: Readonly<Record<string, SqlHandler>>;
  readonly dialect?: Sql.Dialect;
  /** Per-client mutation-id ledger table. Defaults to `"sync_mutations"`. */
  readonly mutationsTable?: string;
}

/** Content-hash fallback version when no version column is mapped. */
export const versionOf = Hash.contentHash;

export const make = (config: SqlBackendConfig): Backend.Backend => {
  const dialect = config.dialect ?? Sql.sqlite;
  const executor = config.executor;
  const mutationsTable = config.mutationsTable ?? "sync_mutations";
  const ph = (index: number) => dialect.placeholder(index);
  const q = (id: string) => dialect.quote(id);

  const idOf = (collection: string) => config.tables[collection]?.idColumn ?? "id";
  const versionFor = (collection: string, row: SqlRow): string | number => {
    const column = config.tables[collection]?.versionColumn;
    return column !== undefined ? (row[column] as string | number) : versionOf(row);
  };

  // Resolve a correlated Exists to its allow-set via a DISTINCT subquery.
  const resolveExistsNode = (
    node: Predicate.ExistsNode
  ): Effect.Effect<ReadonlyArray<Predicate.Literal>, BackendError> => {
    const mapping = config.tables[node.collection];
    if (mapping === undefined) return Effect.succeed([]);
    const where = Sql.compileWhere(node.where, dialect);
    return executor
      .query({
        text: `SELECT DISTINCT ${q(node.foreignField)} FROM ${q(mapping.table)} WHERE ${where.text}`,
        params: where.params,
      })
      .pipe(Effect.map((rows) => rows.map((row) => row[node.foreignField] as Predicate.Literal)));
  };

  const evaluate: Backend.Backend["evaluate"] = (_context, subset) =>
    Effect.gen(function* () {
      const mapping = config.tables[subset.collection];
      if (mapping === undefined) return [];
      const where = yield* Predicate.resolveExists(subset.where, resolveExistsNode);
      const rows = yield* executor.query(
        Sql.compileSelect({ table: mapping.table, where, dialect })
      );
      const idColumn = idOf(subset.collection);
      const values = rows.map((row) => ({ id: String(row[idColumn]), value: row }));
      return Subset.apply(values, { ...subset, where }).map((row) => ({
        id: row.id,
        version: versionFor(subset.collection, row.value),
      }));
    });

  // Fetch the raw rows for explicit ids (shared by getRows and hint
  // enrichment). Reads see the push transaction's own writes.
  const queryRowsById = (
    collection: string,
    ids: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyArray<SqlRow>, BackendError> => {
    const mapping = config.tables[collection];
    if (mapping === undefined || ids.length === 0) return Effect.succeed([]);
    return executor.query(
      Sql.compileSelect({
        table: mapping.table,
        where: Predicate.isIn(idOf(collection), [...ids]),
        dialect,
      })
    );
  };

  const getRows: Backend.Backend["getRows"] = (_context, collection, ids) =>
    queryRowsById(collection, ids).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: String(row[idOf(collection)]),
          version: versionFor(collection, row),
          value: row,
        }))
      )
    );

  // Current (id, value) pairs for explicit ids, for hint enrichment.
  const rowValuesFor = (collection: string, ids: ReadonlyArray<string>) =>
    queryRowsById(collection, ids).pipe(
      Effect.map((rows) => rows.map((row) => ({ id: String(row[idOf(collection)]), value: row })))
    );

  // Attach the current row values to a handler-emitted hint (best-effort, for
  // predicate-level fan-out). The rows still present are PUTs; ids the handler
  // named but that the read no longer returns were deleted (absent from
  // `values`). A collection without a table mapping keeps the hint value-less,
  // so the server falls back to a collection-level match.
  const enrichHint = (hint: Backend.ChangeHint): Effect.Effect<Backend.ChangeHint, BackendError> =>
    config.tables[hint.collection] === undefined
      ? Effect.succeed(hint)
      : rowValuesFor(hint.collection, hint.ids).pipe(Effect.map((values) => ({ ...hint, values })));

  const readLastIds = (
    clientGroupId: string
  ): Effect.Effect<Record<string, number>, BackendError> =>
    executor
      .query({
        text: `SELECT ${q("client_id")}, ${q("last_mutation_id")} FROM ${q(mutationsTable)} WHERE ${q("client_group_id")} = ${ph(1)}`,
        params: [clientGroupId],
      })
      .pipe(
        Effect.map((rows) =>
          Object.fromEntries(
            rows.map((row) => [String(row.client_id), Number(row.last_mutation_id)])
          )
        )
      );

  const bumpLastId = (clientGroupId: string, clientId: string, mutationId: number) =>
    executor.run({
      text:
        `INSERT INTO ${q(mutationsTable)} (${q("client_group_id")}, ${q("client_id")}, ${q("last_mutation_id")}) ` +
        `VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}) ` +
        `ON CONFLICT (${q("client_group_id")}, ${q("client_id")}) DO UPDATE SET ${q("last_mutation_id")} = ${ph(3)}`,
      params: [clientGroupId, clientId, mutationId],
    });

  const applyMutations: Backend.Backend["applyMutations"] = (context, mutations) =>
    executor.transaction(
      Effect.gen(function* () {
        const hints: Array<Backend.ChangeHint> = [];
        const rejected: Array<Backend.RejectedMutation> = [];
        let savepointCounter = 0;
        for (const mutation of mutations) {
          const lastIds = yield* readLastIds(context.clientGroupId);
          const last = lastIds[mutation.clientId] ?? 0;
          if (mutation.mutationId <= last) continue; // idempotent skip
          if (mutation.mutationId > last + 1) {
            return yield* new BackendError({
              message: `Mutation id gap for client ${mutation.clientId}: got ${mutation.mutationId}, expected ${last + 1}`,
            });
          }
          const handler = config.handlers[mutation.mutator];
          const definition = config.mutators.get(mutation.mutator);
          if (handler === undefined || definition === undefined) {
            return yield* new BackendError({ message: `Unknown mutator: ${mutation.mutator}` });
          }
          const args = yield* decodeArgs(definition, mutation.args, mutation.mutator);

          // Run the handler inside a savepoint so a permanent rejection can drop
          // its writes while the lastMutationId bump (committed with the outer
          // transaction) still lands. A transient BackendError aborts the whole
          // transaction and propagates unchanged.
          const savepoint = q(`legation_sp_${savepointCounter++}`);
          yield* executor.run({ text: `SAVEPOINT ${savepoint}`, params: [] });
          const outcome = yield* handler(args, executor, context).pipe(
            Effect.map((hs) => ({ _tag: "applied", hints: hs }) as const),
            Effect.catchTag("MutationRejected", (error) =>
              executor
                .run({ text: `ROLLBACK TO SAVEPOINT ${savepoint}`, params: [] })
                .pipe(Effect.map(() => ({ _tag: "rejected", reason: error.reason }) as const))
            )
          );
          yield* executor.run({ text: `RELEASE SAVEPOINT ${savepoint}`, params: [] });
          if (outcome._tag === "applied") {
            hints.push(...outcome.hints);
          } else {
            rejected.push({
              clientId: mutation.clientId,
              mutationId: mutation.mutationId,
              reason: outcome.reason,
            });
          }
          yield* bumpLastId(context.clientGroupId, mutation.clientId, mutation.mutationId);
        }
        // Enrich once, after all writes, so the reads see the final tx state
        // (a row a later mutation deleted is correctly absent from `values`).
        return {
          lastMutationIds: yield* readLastIds(context.clientGroupId),
          hints: yield* Effect.forEach(hints, enrichHint),
          ...(rejected.length > 0 ? { rejected } : {}),
        };
      })
    );

  return Backend.Backend.of({
    applyMutations,
    lastMutationIds: (context) => readLastIds(context.clientGroupId),
    evaluate,
    getRows,
  });
};
