/**
 * SqlBackend
 *
 * A reference implementation of the core `Backend` contract (ADR-0009) over a
 * SQL database, addressing the audit's "turnkey backend" gap with a
 * driver-agnostic adapter: the app provides a tiny `SqlExecutor` (wrapping
 * `bun:sqlite`, `effect/sql`, `pg`, …) and per-collection table
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
 * ADR-0014). Writes run app-provided handlers inside one transaction (on an
 * executor that has transactions), and each mutation is first claimed in the
 * client's ledger row: a conditional UPDATE
 * from `id - 1` to `id` that runs before its handler. The database evaluates
 * that WHERE against the latest committed row, so of two calls racing for one
 * mutation only one claim matches and the other is a replay the ledger covers.
 * The watermark only ever moves from `id - 1` to `id`, so it cannot fall. This
 * gives the contract's exactly-once, in-order guarantee for one client group,
 * with the claim alone needing no stronger isolation than READ COMMITTED.
 * An executor without transactions (`transactional: false`) cannot commit a
 * claim together with its handler's writes, so it keeps the handler-then-bump
 * order instead (see D1 below).
 *
 * A permanent rejection is remembered in the client's ledger row, in the same
 * transaction as the claim (#366), in a `rejections` column that holds a JSON
 * object of mutation id → reason. A replayed copy lists its mutation in
 * `rejected` with the stored reason, so every copy reports the committed outcome
 * (guarantee 1). A copy that a concurrent call committed first is dropped on
 * each dialect: on SQLite it lists its mutation in `rejected` directly; on
 * PostgreSQL it is refused with a transient `BackendError` (SQLSTATE 40001), and
 * its retry, a replay, lists it. A push forgets the rejections below its lowest
 * id per client. The memory is bounded per client: a client that never pushes
 * again keeps its last push's rejections. It assumes one journal per `clientId`,
 * which backend contiguity already requires.
 *
 * Mutations from different client groups are serialisable (guarantee 1, #353),
 * per dialect:
 *
 * - SQLite serialises transactions on its one connection, and the client takes
 *   the write lock with `BEGIN IMMEDIATE`, so a handler's reads and its writes
 *   never interleave with another group's transaction. It conforms.
 * - PostgreSQL runs each `applyMutations` transaction at SERIALIZABLE: the
 *   dialect's `serializable` statement (`SET TRANSACTION ISOLATION LEVEL
 *   SERIALIZABLE`) runs first, before any read. It must be the transaction's
 *   first statement in a top-level transaction: PostgreSQL refuses it inside a
 *   subtransaction (a nested `transaction`, which a savepoint runs), so
 *   `applyMutations` then fails with a `BackendError` rather than running at
 *   READ COMMITTED. A transaction that read a row another transaction changed
 *   and committed first is refused at its write with SQLSTATE 40001, and rolls
 *   back. The executor reports that as a
 *   `BackendError`, which the client treats as transient and retries, and the
 *   retry runs the handler on the committed state. A handler therefore never
 *   commits a write computed from a stale read. This is not retried inside the
 *   backend: the client already re-sends an unacknowledged batch, so the
 *   transient path covers it without a second retry policy. A PostgreSQL
 *   executor that sets `transactional: false` loses this guarantee, since the
 *   ordering then has no transaction to isolate.
 * - D1 is non-conforming (#342, #353). It has no interactive transactions, so its
 *   executor sets `transactional: false` and each statement commits on its own.
 *   `applyMutations` then keeps trunk's order: the handler runs, then the
 *   ledger is bumped to the larger of the stored and the new id, so an
 *   overlapping call that finishes late cannot move the watermark back. The
 *   handler's writes commit before the bump, so a pull between the two carries
 *   the effect without the watermark; a crash after the writes and before the
 *   bump makes the retry run the handler again; and a transient failure leaves
 *   the writes committed for the retry to repeat. A rejection recorded before a
 *   failed bump is forgotten when the retry applies the id (#425). Nothing
 *   isolates a handler's reads from another group's writes, so a lost update is
 *   possible. The claim order is not used on D1 because a claim committed on its
 *   own would leave a crash between the claim and the handler's commit claimed
 *   and unapplied, so a retry would skip the mutation (#359).
 *
 * An executor on another database must provide the same isolation, or the
 * handlers' reads must be version-checked, before it can claim guarantee 1.
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
} from "@thomasfosterau/legation-effect";
import {
  Hash,
  RejectionMemory,
  Subset,
  UnknownMutator,
} from "@thomasfosterau/legation-effect/internal";
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

/** The `BackendError` for an id past the next expected one (a gap in the client's ids). */
const gapError = (clientId: string, mutationId: number, last: number) =>
  new BackendError({
    message: `Mutation id gap for client ${clientId}: got ${mutationId}, expected ${last + 1}`,
  });

/** One pushed mutation, as `applyMutations` receives it. */
type Mutation = Parameters<Backend.Backend["applyMutations"]>[1][number];

/**
 * How one pushed mutation settled: its handler applied it or rejected it, or a
 * copy the ledger covers was skipped. A replayed copy carries the committed
 * rejection's reason, when there is one (#366).
 */
type Settlement =
  | { readonly _tag: "applied"; readonly hints: ReadonlyArray<Backend.ChangeHint> }
  | { readonly _tag: "rejected"; readonly reason: string }
  | { readonly _tag: "replayed"; readonly rejection: string | undefined };

/** The `rejections` column's value: a JSON object of mutation id → reason, or `null` when none is remembered. */
const encodeRejections = (rejections: ReadonlyMap<number, string>): string | null =>
  rejections.size === 0 ? null : JSON.stringify(Object.fromEntries(rejections));

/** Decode the `rejections` column (`null` and absent both mean none remembered). */
const decodeRejections = (
  text: unknown,
  mutationsTable: string
): Effect.Effect<ReadonlyMap<number, string>, BackendError> => {
  if (text === null || text === undefined) return Effect.succeed(new Map());
  return Effect.try({
    try: () => {
      if (typeof text !== "string") throw new TypeError("not text");
      return new Map(
        Object.entries(JSON.parse(text) as Record<string, string>).map(
          ([id, reason]) => [Number(id), String(reason)] as const
        )
      );
    },
    catch: (cause) =>
      new BackendError({
        message: `The "rejections" column of the mutation ledger "${mutationsTable}" holds a value that is not a rejection memory`,
        cause,
      }),
  });
};

/** A row as returned by the driver: a column → value record. */
export type SqlRow = Record<string, unknown>;

/**
 * The minimal database surface the backend needs.
 *
 * **Isolation (guarantee 1, #353):** `transaction` must run its effect as one
 * database transaction whose reads a concurrent transaction cannot change under
 * them before it commits, so a handler never writes from a stale read. That is
 * SERIALIZABLE isolation, or an equivalent check, and the reference executors
 * meet it: SQLite serialises writers (`BEGIN IMMEDIATE`), and the PostgreSQL
 * dialect's `serializable` statement sets SERIALIZABLE on each transaction. On
 * PostgreSQL that transaction must be top-level, not a nested one run as a
 * savepoint: the statement is refused there, and `applyMutations` fails with a
 * `BackendError`. An executor whose database cannot do this does not conform. A
 * serialization failure (PostgreSQL SQLSTATE 40001 or 40P01) must surface as a
 * `BackendError`, so the client retries the batch; the D1 executor does not meet
 * the requirement (`transactional: false`, #342).
 */
export interface SqlExecutor {
  /** Run a query and return its rows. */
  readonly query: (fragment: Sql.SqlFragment) => Effect.Effect<ReadonlyArray<SqlRow>, BackendError>;
  /** Run a statement for its effect (insert/update/delete). */
  readonly run: (fragment: Sql.SqlFragment) => Effect.Effect<void, BackendError>;
  /**
   * Run an effect inside a transaction (atomic commit / rollback on error). On
   * PostgreSQL it must open a top-level transaction, not a savepoint nested in
   * another one, so SERIALIZABLE can be set first (see the `dialect` option of
   * `SqlBackendConfig`).
   */
  readonly transaction: <A, R>(
    effect: Effect.Effect<A, BackendError, R>
  ) => Effect.Effect<A, BackendError, R>;
  /**
   * Whether `transaction` commits and rolls back atomically; defaults to `true`.
   *
   * Set `false` on an executor without transactions (D1). `applyMutations` then
   * bumps each id after its handler instead of claiming it first, because a
   * claim committed on its own would be skipped by a retry after a crash.
   */
  readonly transactional?: boolean | undefined;
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

/** Configuration for {@link make}. */
export interface SqlBackendConfig {
  readonly executor: SqlExecutor;
  readonly tables: Readonly<Record<string, TableMapping>>;
  /** Mutator definitions, for decoding/validating pushed args. */
  readonly mutators: ReadonlyMap<string, Mutator.AnyMutator>;
  readonly handlers: Readonly<Record<string, SqlHandler>>;
  /**
   * The SQL dialect. Defaults to SQLite (`Sql.sqlite`). A PostgreSQL app must pass
   * `Sql.postgres`: that sets SERIALIZABLE on each transaction, and omitting it runs
   * the batches at READ COMMITTED with no error. A hand-written dialect without a
   * `serializable` statement gets no isolation statement, so its executor must
   * provide the isolation itself (see {@link SqlExecutor}).
   */
  readonly dialect?: Sql.Dialect | undefined;
  /**
   * Per-client mutation-id ledger table. Defaults to `"sync_mutations"`. It must
   * have the `rejections` column that #366 added: an older table fails the push
   * with a `BackendError` naming the migration (see the sql README).
   */
  readonly mutationsTable?: string;
}

/** Content-hash fallback version when no version column is mapped. */
export const versionOf = Hash.contentHash;

/** One client's ledger row: its watermark and the rejections it still remembers (#366). */
interface LedgerRow {
  readonly last: number;
  readonly rejections: ReadonlyMap<number, string>;
}

/**
 * A {@link Backend.Backend} over a {@link SqlExecutor}: subset evaluation, row fetch and the
 * transactional, idempotent mutation-id ledger.
 */
export const make = (config: SqlBackendConfig): Backend.Backend => {
  const dialect = config.dialect ?? Sql.sqlite;
  const executor = config.executor;
  const transactional = executor.transactional ?? true;
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

  // The group's ledger rows with their rejection memory (#366). Every push reads
  // it, so a ledger without the `rejections` column fails here, on the first
  // push after an upgrade, naming the migration instead of failing silently.
  const readLedger = (
    clientGroupId: string
  ): Effect.Effect<ReadonlyMap<string, LedgerRow>, BackendError> =>
    executor
      .query({
        text: `SELECT ${q("client_id")}, ${q("last_mutation_id")}, ${q("rejections")} FROM ${q(mutationsTable)} WHERE ${q("client_group_id")} = ${ph(1)}`,
        params: [clientGroupId],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BackendError({
              message:
                `The mutation ledger "${mutationsTable}" could not be read with its "rejections" column. ` +
                `If the column is missing, check for it, then run \`ALTER TABLE ${mutationsTable} ADD COLUMN rejections TEXT\` ` +
                `(the sql README's "Ledger without the \`rejections\` column" section).`,
              cause,
            })
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeRejections(row.rejections, mutationsTable).pipe(
              Effect.map(
                (rejections) =>
                  [
                    String(row.client_id),
                    { last: Number(row.last_mutation_id), rejections },
                  ] as const
              )
            )
          )
        ),
        Effect.map((entries) => new Map(entries))
      );

  // Replace one client's remembered rejections (`null` when the set is empty).
  const writeRejections = (
    clientGroupId: string,
    clientId: string,
    rejections: ReadonlyMap<number, string>
  ) =>
    executor.run({
      text: `UPDATE ${q(mutationsTable)} SET ${q("rejections")} = ${ph(1)} WHERE ${q("client_group_id")} = ${ph(2)} AND ${q("client_id")} = ${ph(3)}`,
      params: [encodeRejections(rejections), clientGroupId, clientId],
    });

  // Remember a permanent rejection in the client's ledger row (#366). It runs in
  // the same transaction as the claim (or, without transactions, before the
  // bump), so a copy that reads the row afterwards sees the outcome with the id.
  // The row is created at 0 first if it does not exist yet: a D1 push records the
  // rejection before the bump that would otherwise create the row.
  const recordRejection = (
    clientGroupId: string,
    clientId: string,
    mutationId: number,
    reason: string
  ) =>
    Effect.gen(function* () {
      yield* ensureLedgerRow(clientGroupId, clientId);
      const row = (yield* readLedger(clientGroupId)).get(clientId);
      const rejections = new Map(row?.rejections ?? []);
      rejections.set(mutationId, reason);
      yield* writeRejections(clientGroupId, clientId, rejections);
    });

  // Forget the rejections a push has moved past: for each client in the push, the
  // remembered rejections below its lowest id in the push (#355, as MemoryBackend).
  const forgetRejections = (clientGroupId: string, floors: ReadonlyMap<string, number>) =>
    Effect.gen(function* () {
      if (floors.size === 0) return;
      const ledger = yield* readLedger(clientGroupId);
      for (const [clientId, floor] of floors) {
        const row = ledger.get(clientId);
        if (row === undefined || row.rejections.size === 0) continue;
        const kept = new Map([...row.rejections].filter(([mutationId]) => mutationId >= floor));
        if (kept.size !== row.rejections.size) {
          yield* writeRejections(clientGroupId, clientId, kept);
        }
      }
    });

  // Create the client's ledger row at 0 when it has none. `DO NOTHING` leaves a
  // row another transaction inserted alone (on PostgreSQL the insert waits for
  // that transaction to commit or roll back first), so the claim below finds
  // exactly one row either way.
  const ensureLedgerRow = (clientGroupId: string, clientId: string) =>
    executor.run({
      text:
        `INSERT INTO ${q(mutationsTable)} (${q("client_group_id")}, ${q("client_id")}, ${q("last_mutation_id")}) ` +
        `VALUES (${ph(1)}, ${ph(2)}, 0) ` +
        `ON CONFLICT (${q("client_group_id")}, ${q("client_id")}) DO NOTHING`,
      params: [clientGroupId, clientId],
    });

  // The claim: one conditional UPDATE from `mutationId - 1` to `mutationId`. The
  // database evaluates the WHERE against the latest committed row, so two calls
  // racing for one mutation cannot both match (READ COMMITTED re-checks the
  // WHERE once a concurrent writer commits). RETURNING says whether this call
  // moved the row. Only the claim decides; no read is trusted to decide it.
  const claimLedger = (
    clientGroupId: string,
    clientId: string,
    mutationId: number
  ): Effect.Effect<boolean, BackendError> =>
    executor
      .query({
        text:
          `UPDATE ${q(mutationsTable)} SET ${q("last_mutation_id")} = ${ph(1)} ` +
          `WHERE ${q("client_group_id")} = ${ph(2)} AND ${q("client_id")} = ${ph(3)} ` +
          `AND ${q("last_mutation_id")} = ${ph(4)} RETURNING ${q("last_mutation_id")}`,
        params: [mutationId, clientGroupId, clientId, mutationId - 1],
      })
      .pipe(Effect.map((rows) => rows.length > 0));

  // Claim `mutationId` before its handler runs. `undefined`: this call won the
  // claim and must run the handler. A `replayed` settlement: the ledger already
  // covers the id, so it is a replay to skip, reporting the committed rejection
  // when there is one (#366). Otherwise the id is past the next expected one: a
  // gap, a `BackendError`. A zero-row claim re-reads the ledger, which only ever
  // rises, so a stale claim cannot move the watermark back.
  const claimMutation = (
    clientGroupId: string,
    clientId: string,
    mutationId: number
  ): Effect.Effect<Settlement | undefined, BackendError> =>
    Effect.gen(function* () {
      yield* ensureLedgerRow(clientGroupId, clientId);
      if (yield* claimLedger(clientGroupId, clientId, mutationId)) return undefined;
      const row = (yield* readLedger(clientGroupId)).get(clientId);
      const last = row?.last ?? 0;
      if (mutationId <= last) {
        return { _tag: "replayed", rejection: row?.rejections.get(mutationId) };
      }
      return yield* gapError(clientId, mutationId, last);
    });

  // The bump of the handler-then-bump order (executors without transactions).
  // It runs after the handler's writes, and it takes the larger of the stored and
  // the new id, so a call that parked before a later bump cannot move the
  // watermark back when it finishes (#352). It is not atomic with those writes
  // (#342).
  const bumpLastId = (clientGroupId: string, clientId: string, mutationId: number) =>
    executor.run({
      text:
        `INSERT INTO ${q(mutationsTable)} (${q("client_group_id")}, ${q("client_id")}, ${q("last_mutation_id")}) ` +
        `VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}) ` +
        // `excluded.` instead of re-binding ph(3): with `?` placeholders a
        // reused index renders an extra placeholder with no matching param
        // (found by the commerce example's contract run over node:sqlite).
        // The stored row's column is qualified with the table name: PostgreSQL
        // reads an unqualified name here as ambiguous with `excluded` (#390).
        `ON CONFLICT (${q("client_group_id")}, ${q("client_id")}) DO UPDATE SET ${q("last_mutation_id")} = ` +
        dialect.greatest(
          `${q(mutationsTable)}.${q("last_mutation_id")}`,
          `excluded.${q("last_mutation_id")}`
        ),
      params: [clientGroupId, clientId, mutationId],
    });

  // Give a claim back after its handler failed transiently. A transaction rolls
  // the claim back with the handler's effects. An executor without transactions
  // (D1, see D1Executor) keeps it, so this restores the id and the client's
  // retry applies the mutation again. Best effort: the handler's error is what
  // the caller sees, and inside a failed PostgreSQL transaction this statement
  // is refused and ignored, the rollback doing the work instead.
  const releaseClaim = (clientGroupId: string, clientId: string, mutationId: number) =>
    executor
      .run({
        text:
          `UPDATE ${q(mutationsTable)} SET ${q("last_mutation_id")} = ${ph(1)} ` +
          `WHERE ${q("client_group_id")} = ${ph(2)} AND ${q("client_id")} = ${ph(3)} ` +
          `AND ${q("last_mutation_id")} = ${ph(4)}`,
        params: [mutationId - 1, clientGroupId, clientId, mutationId],
      })
      .pipe(Effect.ignore);

  // Run one mutation's handler inside a savepoint, so a permanent rejection drops
  // its writes while the id's ledger write (the claim, or the bump after it)
  // stays. A transient BackendError propagates and aborts the batch.
  const runHandler = (context: Backend.SyncContext, mutation: Mutation, savepointIndex: number) =>
    Effect.gen(function* () {
      const handler = config.handlers[mutation.mutator];
      const definition = config.mutators.get(mutation.mutator);
      if (handler === undefined || definition === undefined) {
        return yield* UnknownMutator.make(mutation.mutator);
      }
      const args = yield* decodeArgs(definition, mutation.args, mutation.mutator);

      const savepoint = q(`legation_sp_${savepointIndex}`);
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
      return outcome;
    });

  // Claim-first, for an executor with transactions: the id is claimed, then its
  // handler runs. A transient failure gives the claim back (best effort; the
  // transaction's rollback does the same when it aborts the batch). A permanent
  // rejection is remembered in the same transaction as the claim (#366).
  const applyClaimFirst = (
    context: Backend.SyncContext,
    mutation: Mutation,
    savepointIndex: number
  ): Effect.Effect<Settlement, BackendError> =>
    Effect.gen(function* () {
      const replayed = yield* claimMutation(
        context.clientGroupId,
        mutation.clientId,
        mutation.mutationId
      );
      if (replayed !== undefined) return replayed;
      const outcome = yield* runHandler(context, mutation, savepointIndex).pipe(
        Effect.onError(() =>
          releaseClaim(context.clientGroupId, mutation.clientId, mutation.mutationId)
        )
      );
      if (outcome._tag === "rejected") {
        yield* recordRejection(
          context.clientGroupId,
          mutation.clientId,
          mutation.mutationId,
          outcome.reason
        );
      }
      return outcome;
    });

  // Handler-then-bump, for an executor without transactions (D1): trunk's order.
  // The ledger is read first, a covered id is skipped, and the id is bumped only
  // after the handler has run. Nothing is claimed, so a crash cannot leave an id
  // claimed and unapplied. A rejection is recorded before the bump, so a copy
  // that sees the id as covered also sees its rejection (#366).
  const applyBumpAfter = (
    context: Backend.SyncContext,
    mutation: Mutation,
    savepointIndex: number
  ): Effect.Effect<Settlement, BackendError> =>
    Effect.gen(function* () {
      const row = (yield* readLedger(context.clientGroupId)).get(mutation.clientId);
      const last = row?.last ?? 0;
      if (mutation.mutationId <= last) {
        return { _tag: "replayed", rejection: row?.rejections.get(mutation.mutationId) };
      }
      if (mutation.mutationId > last + 1) {
        return yield* gapError(mutation.clientId, mutation.mutationId, last);
      }
      const outcome = yield* runHandler(context, mutation, savepointIndex);
      if (outcome._tag === "rejected") {
        yield* recordRejection(
          context.clientGroupId,
          mutation.clientId,
          mutation.mutationId,
          outcome.reason
        );
      } else if (row?.rejections.has(mutation.mutationId)) {
        // An earlier copy was rejected and recorded it, but its bump failed, so the
        // id was never acknowledged and this copy applies it. The stale rejection
        // goes before the bump: a bump that then fails leaves the id unacknowledged
        // with no rejection to report, and a replay after the bump must not report
        // one for an applied mutation (#425).
        const rejections = new Map(row.rejections);
        rejections.delete(mutation.mutationId);
        yield* writeRejections(context.clientGroupId, mutation.clientId, rejections);
      }
      yield* bumpLastId(context.clientGroupId, mutation.clientId, mutation.mutationId);
      return outcome;
    });

  // The ordering this executor uses; chosen once, outside the generator.
  const applyOne = transactional ? applyClaimFirst : applyBumpAfter;

  // The transaction's isolation, set before any read so every read in it sees
  // the snapshot SERIALIZABLE gives (#353). An executor without transactions has
  // nothing to isolate, and SQLite has no such statement (its writers serialise).
  const serializable = transactional ? dialect.serializable : undefined;

  const applyMutations: Backend.Backend["applyMutations"] = (context, mutations) =>
    executor.transaction(
      Effect.gen(function* () {
        if (serializable !== undefined) {
          // PostgreSQL refuses this statement inside a subtransaction (a nested
          // transaction, which the executor runs as a savepoint) or after another
          // statement. A refusal fails the batch: the batch must never run at READ
          // COMMITTED without saying so (#353). The client retries it.
          yield* executor.run({ text: serializable, params: [] }).pipe(
            Effect.mapError(
              (cause) =>
                new BackendError({
                  message:
                    "SERIALIZABLE isolation could not be set for this mutation batch. On PostgreSQL the " +
                    "executor's transaction must be top-level, with this statement first: SET TRANSACTION " +
                    "fails inside a nested transaction (a savepoint) or after another statement.",
                  cause,
                })
            )
          );
        }
        // The rejections this push has moved past are forgotten first (#366).
        yield* forgetRejections(context.clientGroupId, RejectionMemory.floorsOf(mutations));
        const hints: Array<Backend.ChangeHint> = [];
        const rejected: Array<Backend.RejectedMutation> = [];
        // Numbered per handler run, as trunk did: a replay runs no savepoint and
        // takes no number.
        let savepointCounter = 0;
        for (const mutation of mutations) {
          // Ids start at 1 and the ledger at 0, so a non-positive id is never
          // new: skip it without writing a ledger row for it.
          if (mutation.mutationId <= 0) continue;
          const settled = yield* applyOne(context, mutation, savepointCounter);
          if (settled._tag === "replayed") {
            // A copy the ledger covers runs no handler. It reports the committed
            // rejection, if there is one, so every copy agrees (#366).
            if (settled.rejection !== undefined) {
              rejected.push({
                clientId: mutation.clientId,
                mutationId: mutation.mutationId,
                reason: settled.rejection,
              });
            }
            continue;
          }
          savepointCounter++;
          if (settled._tag === "applied") {
            hints.push(...settled.hints);
          } else {
            rejected.push({
              clientId: mutation.clientId,
              mutationId: mutation.mutationId,
              reason: settled.reason,
            });
          }
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

  // The group's remembered rejections, from every client's ledger row (#365). A pull
  // reports the ones its watermark covers.
  const rememberedRejections = (
    clientGroupId: string
  ): Effect.Effect<ReadonlyArray<Backend.RejectedMutation>, BackendError> =>
    readLedger(clientGroupId).pipe(
      Effect.map((ledger) =>
        [...ledger].flatMap(([clientId, row]) =>
          [...row.rejections].map(([mutationId, reason]) => ({ clientId, mutationId, reason }))
        )
      )
    );

  return Backend.Backend.of({
    applyMutations,
    lastMutationIds: (context) => readLastIds(context.clientGroupId),
    rejections: (context) => rememberedRejections(context.clientGroupId),
    evaluate,
    getRows,
  });
};
