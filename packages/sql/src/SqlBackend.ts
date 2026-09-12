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
 * Reads go through the `Sql` translator (`Subset` predicate → `WHERE`, exact
 * under ADR-0028 on both dialects), then `Subset.apply` finalises
 * order/limit/cursor locally. A table mapping may declare its columns'
 * literal kinds (`TableMapping.kinds`) so the compiler collates declared-text
 * columns and binds literals by kind (booleans per dialect); the row decoder
 * maps SQLite's `0`/`1` back to booleans for columns declared `boolean`, and
 * otherwise leaves rows as the driver returns them (values stay opaque,
 * ADR-0014). Writes run app-provided handlers inside one
 * transaction with the per-client `lastMutationId` bump — the contract's
 * exactly-once, in-order, atomic guarantee, delegated to the database.
 *
 * A mapping's reads run against `readRelation` when given (issue #204): a
 * real app's current-state relation is often a view — one that resolves each
 * node's current version and joins the leaf at exactly that version — never
 * the table mutator handlers write through. A mapping's `tombstone`
 * predicate (the engine's own `Predicate` vocabulary, evaluated with
 * `Predicate.test`) marks a row a soft delete rather than a live one: such a
 * row is dropped from `evaluate`'s returned entries, so it simply isn't in
 * the next CVR view and `Cvr.diff` reports it as a delete for that id,
 * exactly as a row that vanished from the relation outright would (fail-open
 * would be a bug: a soft-deleted row must never keep syncing as a put).
 */

import { Effect, Schema } from "effect";
import {
  Backend,
  BackendError,
  Collection,
  MutationRejected,
  Predicate,
  type Mutator,
} from "@legation/effect";
import { Hash, Subset } from "@legation/effect/internal";
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
  /** The write target: what mutator handlers address. Also the read default. */
  readonly table: string;
  /**
   * The relation reads evaluate against, when it differs from `table`
   * (issue #204) — typically a view joining a root version table to a leaf
   * at its current version. Read-only: `SqlBackend` never writes rows
   * itself, only the mutation-id ledger, so nothing here needs `table` to be
   * writable. Defaults to `table`.
   */
  readonly readRelation?: string;
  /** Primary-key column. Defaults to `"id"`. */
  readonly idColumn?: string;
  /** Column holding the row version; if absent, a content hash is used. */
  readonly versionColumn?: string;
  /**
   * Declared literal kinds of the filterable columns (field → kind), passed
   * to the `Sql` compiler: a column declared `text` gets the code-point
   * collation clause (the clause needs the declaration; a string literal
   * alone never collates), `instant` columns do not, literals bind by the
   * declared kind, and `boolean` columns bind and decode as the dialect
   * stores them (`0`/`1` on SQLite). A column without a kind compiles to a
   * plain comparison with the literal bound as its JS type (see `Sql`). See
   * {@link fromCollection} to derive this instead of writing it by hand.
   */
  readonly kinds?: Sql.Kinds;
  /**
   * A row matching this predicate is a tombstone, not a live row (issue
   * #204): `evaluate` drops it from the entries it returns, so it is simply
   * absent from the next CVR view and diffs as a delete, the same as a row
   * that vanished from the relation outright. Expressed in the engine's own
   * `Predicate` vocabulary (evaluated with `Predicate.test`) rather than a
   * bespoke shape, so it composes with everything else that already
   * understands a `Predicate` (the `Sql` compiler, the differential
   * harness). Typically an `IsNull`/`eq` test on a soft-delete column
   * (`Predicate.isNotNull("deletedAt")`'s negation, an `action` enum check).
   */
  readonly tombstone?: Predicate.Predicate;
}

/**
 * Derive a `TableMapping` from a `Collection`: column kinds come from its
 * declared filterable set (`Collection.filterDeclarationOf`, #154) instead of
 * being restated by hand — the common case. `table`, and optionally
 * `readRelation` / `idColumn` / `versionColumn` / `tombstone`, are still
 * given explicitly; the hand-written record shape (this function's return
 * type) remains the override path for a mapping derivation can't cover.
 */
export const fromCollection = (
  collection: Collection.AnyCollection,
  options: {
    readonly table: string;
    readonly readRelation?: string;
    readonly idColumn?: string;
    readonly versionColumn?: string;
    readonly tombstone?: Predicate.Predicate;
  }
): TableMapping => {
  const { filterable } = Collection.filterDeclarationOf(collection);
  const kinds: Sql.Kinds = Object.fromEntries(
    Object.entries(filterable).map(([field, declared]) => [field, declared.kind])
  );
  return { ...options, kinds };
};

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
  // What a read queries: the mapping's `readRelation` when it names one
  // (typically a view), else the write target `table` (#204).
  const readTableOf = (mapping: TableMapping) => mapping.readRelation ?? mapping.table;
  // Whether a decoded row is a live row, not a tombstone: no mapping or no
  // declared predicate means every row is live.
  const isLive = (collection: string, value: SqlRow): boolean => {
    const tombstone = config.tables[collection]?.tombstone;
    return tombstone === undefined || !Predicate.test(tombstone, value);
  };

  // Every mapping's declared kinds, keyed by collection, for the inner
  // `where` of an `Exists` (the compiler picks the foreign collection's).
  const foreignKinds: Record<string, Sql.Kinds> = Object.fromEntries(
    Object.entries(config.tables).flatMap(([collection, mapping]) =>
      mapping.kinds === undefined ? [] : [[collection, mapping.kinds] as const]
    )
  );
  // The columns declared `boolean` per collection, fixed once so decoding a
  // row costs nothing for a collection with none.
  const booleanColumns: Record<string, ReadonlyArray<string>> = Object.fromEntries(
    Object.entries(config.tables).map(([collection, mapping]) => [
      collection,
      Object.entries(mapping.kinds ?? {})
        .filter(([, kind]) => kind === "boolean")
        .map(([field]) => field),
    ])
  );

  // Map a driver row back to the engine's values: a column declared
  // `boolean` comes back as `0`/`1` from SQLite and is decoded to a boolean;
  // every other column stays exactly as the driver returned it, and a row
  // with nothing to decode is returned as is (no copy).
  const decodeRow = (collection: string, row: SqlRow): SqlRow => {
    let decoded: Record<string, unknown> | undefined;
    for (const field of booleanColumns[collection] ?? []) {
      const value = row[field];
      if (value !== 0 && value !== 1) continue;
      decoded ??= { ...row };
      decoded[field] = value === 1;
    }
    return decoded ?? row;
  };

  // Resolve a correlated Exists to its allow-set via a DISTINCT subquery.
  // NULL foreign values are left out and the rest decoded by kind, exactly
  // as `Predicate.existsValues` does for MemoryBackend (ADR-0028 rule (b)):
  // NULL equals nothing, so it must not make `Not(Exists)` unknown. A
  // tombstoned foreign row is excluded the same way: a soft-deleted row
  // never satisfies a correlation.
  const resolveExistsNode = (
    node: Predicate.ExistsNode
  ): Effect.Effect<ReadonlyArray<Predicate.Literal>, BackendError> => {
    const mapping = config.tables[node.collection];
    if (mapping === undefined) return Effect.succeed([]);
    const where = Sql.compileWhere(node.where, dialect, { kinds: mapping.kinds, foreignKinds });
    return executor
      .query({
        text: `SELECT DISTINCT ${q(node.foreignField)} FROM ${q(readTableOf(mapping))} WHERE ${where.text}`,
        params: where.params,
      })
      .pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => {
            const decoded = decodeRow(node.collection, row);
            if (!isLive(node.collection, decoded)) return [];
            const value = decoded[node.foreignField];
            return Predicate.isNullish(value) ? [] : [value as Predicate.Literal];
          })
        )
      );
  };

  const evaluate: Backend.Backend["evaluate"] = (_context, subset) =>
    Effect.gen(function* () {
      const mapping = config.tables[subset.collection];
      if (mapping === undefined) return [];
      const where = yield* Predicate.resolveExists(subset.where, resolveExistsNode);
      const rows = yield* executor.query(
        Sql.compileSelect({
          table: readTableOf(mapping),
          where,
          dialect,
          kinds: mapping.kinds,
          foreignKinds,
        })
      );
      const idColumn = idOf(subset.collection);
      // A tombstoned row is dropped here, before ordering/limit/cursor: it is
      // not a live row to page over, and its absence from the returned
      // entries is exactly what makes `Cvr.diff` report it as a delete
      // (#204) — the same mechanism a row vanishing from the relation
      // outright already relies on.
      const values = rows
        .map((row) => ({ id: String(row[idColumn]), value: decodeRow(subset.collection, row) }))
        .filter((row) => isLive(subset.collection, row.value));
      return Subset.apply(values, { ...subset, where }).map((row) => ({
        id: row.id,
        version: versionFor(subset.collection, row.value),
      }));
    });

  // Fetch the raw rows for explicit ids (shared by getRows and hint
  // enrichment). Reads see the push transaction's own writes. A tombstoned
  // row is omitted, exactly like an id no longer in the relation (#204).
  const queryRowsById = (
    collection: string,
    ids: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyArray<SqlRow>, BackendError> => {
    const mapping = config.tables[collection];
    if (mapping === undefined || ids.length === 0) return Effect.succeed([]);
    return executor
      .query(
        Sql.compileSelect({
          table: readTableOf(mapping),
          where: Predicate.isIn(idOf(collection), [...ids]),
          dialect,
          kinds: mapping.kinds,
        })
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => decodeRow(collection, row)).filter((row) => isLive(collection, row))
        )
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
        // `excluded.` instead of re-binding ph(3): with `?` placeholders a
        // reused index renders an extra placeholder with no matching param
        // (found by the commerce example's contract run over node:sqlite).
        `ON CONFLICT (${q("client_group_id")}, ${q("client_id")}) DO UPDATE SET ${q("last_mutation_id")} = excluded.${q("last_mutation_id")}`,
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
