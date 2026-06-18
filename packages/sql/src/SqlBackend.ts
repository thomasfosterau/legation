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
  Predicate,
  Subset,
  type Mutator,
} from "@thomasfosterau/effect-sync-core";
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

/** An app-authored write, running its own SQL inside the push transaction. */
export type SqlHandler = (
  args: unknown,
  tx: SqlExecutor,
  context: Backend.SyncContext
) => Effect.Effect<ReadonlyArray<Backend.ChangeHint>, BackendError>;

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

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

/** Content-hash fallback version (FNV-1a) when no version column is mapped. */
export const versionOf = (value: unknown): string => {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

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

  const evaluate: Backend.Backend["evaluate"] = (_context, subset) => {
    const mapping = config.tables[subset.collection];
    if (mapping === undefined) return Effect.succeed([]);
    const select = Sql.compileSelect({ table: mapping.table, where: subset.where, dialect });
    return executor.query(select).pipe(
      Effect.map((rows) => {
        const idColumn = idOf(subset.collection);
        const values = rows.map((row) => ({ id: String(row[idColumn]), value: row }));
        return Subset.apply(values, subset).map((row) => ({
          id: row.id,
          version: versionFor(subset.collection, row.value),
        }));
      })
    );
  };

  const getRows: Backend.Backend["getRows"] = (_context, collection, ids) => {
    const mapping = config.tables[collection];
    if (mapping === undefined || ids.length === 0) return Effect.succeed([]);
    const idColumn = idOf(collection);
    const select = Sql.compileSelect({
      table: mapping.table,
      where: Predicate.isIn(idColumn, [...ids]),
      dialect,
    });
    return executor.query(select).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: String(row[idColumn]),
          version: versionFor(collection, row),
          value: row,
        }))
      )
    );
  };

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
          hints.push(...(yield* handler(args, executor, context)));
          yield* bumpLastId(context.clientGroupId, mutation.clientId, mutation.mutationId);
        }
        return { lastMutationIds: yield* readLastIds(context.clientGroupId), hints };
      })
    );

  return Backend.Backend.of({
    applyMutations,
    lastMutationIds: (context) => readLastIds(context.clientGroupId),
    evaluate,
    getRows,
  });
};
