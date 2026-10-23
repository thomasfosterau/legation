# @thomasfosterau/legation-sql

A driver-agnostic SQL reference backend for the
[`@thomasfosterau/legation-effect`](../effect) engine.

- **`Sql`** — a pure translator from a `Subset` predicate to a parameterized
  `WHERE` clause (and a full `SELECT`), with SQLite (`?`) and PostgreSQL (`$n`)
  dialects.
- **`SqlBackend`** — an implementation of the core `Backend` contract over a
  tiny `SqlExecutor` seam (`query` / `run` / `transaction`, and the optional
  `transactional` flag, which an executor without transactions sets to
  `false`). Bring your own
  driver (`better-sqlite3`, `effect/sql`, `pg`, …); the backend supplies
  subset evaluation, row fetching, and the transactional, idempotent,
  gap-checked mutation-id ledger.
- **`PgExecutor`** — the `SqlExecutor` for PostgreSQL, over the `SqlClient`
  service from `effect/sql` (the driver, such as `@effect/sql-pg`, is yours to
  provide). See [PostgreSQL](#postgresql) below.
- **`PollingHintSource`** — a tier-2 change-data-capture hint source over the
  same `SqlExecutor` seam: it polls each table on an interval for a cheap
  change-detector (`COUNT(*)` plus `MAX(versionColumn)`) and pokes subscribers
  when a collection changes out of band (cron, admin tools, `psql`). See the
  [change-data-capture guide](../../docs/change-data-capture.md).

Reads push the predicate to the database via `WHERE` and finalise
order/limit/cursor locally with `Subset.apply`. The `WHERE` is exact on both
dialects (ADR-0028): every node compiles to the three-valued expression
`Predicate.evaluate` computes. A table mapping's `kinds` declare which columns
are text, instants, numbers or booleans: a column declared `text` gets an
explicit code-point collation (`COLLATE "C"` / `COLLATE BINARY`) on every
comparison, literals bind by the declared kind, and booleans are stored as
`0`/`1` on SQLite and decoded back by the backend. Writes run app-authored
handlers inside one transaction, and each mutation's `lastMutationId` is
claimed before its handler runs. Mutations from different client groups are
serialisable: SQLite serialises its writers, and PostgreSQL runs each
transaction at `SERIALIZABLE` (a handler whose reads went stale is refused
with a serialization failure, which the client retries). An executor without
transactions sets `transactional: false` and bumps after the handler instead
(D1), and D1 does not isolate handlers, so it does not meet that guarantee.
A permanent rejection is remembered in the client's ledger row, and a replayed
copy reports it. A copy that a concurrent call committed first is dropped
differently by dialect: on SQLite it lists its rejection directly, and on
PostgreSQL it is refused with a transient `BackendError`, and its retry lists it.

> **PostgreSQL apps must pass `dialect: Sql.postgres` to `SqlBackend.make`.**
> That dialect is what sets `SERIALIZABLE` on each mutation transaction. Leave it
> out and the backend falls back to SQLite's dialect, which runs no isolation
> statement and raises no error for that. Batches then run at PostgreSQL's default
> READ COMMITTED, and a lost update across client groups goes unreported.
> A hand-written dialect without a `serializable` statement also gets no
> isolation statement, so its executor must provide the isolation itself. The
> executor's `transaction` must also open a top-level transaction, not a savepoint
> nested in another: PostgreSQL refuses `SET TRANSACTION` there, and the batch
> fails with a `BackendError` instead of running weaker.

## PostgreSQL

`PgExecutor.make(sql)` turns a PostgreSQL `SqlClient` into the executor
`SqlBackend` runs over. It needs only `effect`, so this package gains no
dependency; install a driver that provides `SqlClient`, such as
`@effect/sql-pg`, and pass `dialect: Sql.postgres`:

```ts
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";
import { PgExecutor, Sql, SqlBackend } from "@thomasfosterau/legation-sql";

const makeBackend = Effect.gen(function* () {
  const sql = yield* SqlClient; // provided by PgClient.layer({ url }) from @effect/sql-pg
  return SqlBackend.make({
    executor: PgExecutor.make(sql),
    dialect: Sql.postgres,
    tables,
    mutators,
    handlers,
  });
});
```

What the executor guarantees:

- **Each push is one transaction.** `transaction` is the client's
  `withTransaction`: one `BEGIN … COMMIT` on one connection, so a batch's
  mutation-id claims commit together with its handlers' writes, and a failure
  rolls back both. `Sql.postgres` runs the transaction at `SERIALIZABLE`; a
  handler whose reads went stale is refused (SQLSTATE 40001) with a
  `BackendError`, and the client retries. Don't run the backend inside an outer
  `withTransaction`: that makes the batch a savepoint, where PostgreSQL refuses
  `SET TRANSACTION`, and the push fails.
- **Statements run unprepared.** Nothing depends on a named prepared statement
  surviving from one query to the next, which a transaction-mode pooler does
  not promise.
- **Round trips.** A push costs one transaction, however many mutations it
  holds. `evaluate` costs one statement per subset, plus one per `exists` node
  in its predicate. A pull goes through `evaluateMany`, which asks for all of
  its subsets in one `UNION ALL` statement, plus one per `exists` node, however
  many subsets it holds
  ([#505](https://github.com/thomasfosterau/legation/issues/505)).
- **Rows as JSON in a pull.** Each arm of `evaluateMany`'s statement carries
  its row as JSON (`row_to_json`), since mappings' columns differ, and the
  backend orders, windows and versions the rows it reads back from that JSON.
  A column JSON represents as the driver does (text, `integer`, `double
  precision`, booleans, `NULL`) gives the same answer as `evaluate`. A pull
  whose rows hold an integer past ±(2^53 − 1) (a `bigint` id, version or
  ordered column that wide) falls back to one `evaluate` per subset, since
  JSON would round it. Other types the driver does not read as JSON does
  (`bigint` and `numeric`, which the driver reads as text; `timestamptz`,
  which it reads as a `Date`) reach the backend as JSON gives them, so a
  `versionColumn` or ordered column of those types gives the pull versions or
  an order of a different type than `evaluate` and `getRows`: declare such
  columns `integer`, `double precision` or `text` in the read relation (a view
  can cast them). SQLite has no such caveat: its `UNION ALL` columns take any
  type per row, so each arm carries the relation's own columns by position.
- **Errors.** A failed statement or transaction fails as a `BackendError` with
  the statement's text, never its parameters, in the message, and the driver's
  `SqlError` as its `cause`.

### Behind a pooler (Hyperdrive)

The atomicity above holds only if every statement from `BEGIN` to `COMMIT`
reaches the same server connection. A pooler that runs a transaction on one
connection keeps it; one that can split a transaction across connections breaks
Backend guarantee 1, as D1 does (see `D1Executor`). In a Worker, build the
`PgClient` layer per request, inside the request's scope, from the binding's
connection string: a Worker cannot reuse one request's connection in another.
What Hyperdrive guarantees about transactions, isolation statements and query
caching is still to be confirmed against its documentation:
[#506](https://github.com/thomasfosterau/legation/issues/506).

## Ledger without the `rejections` column

**Action required before upgrading.** `SqlBackend` remembers each permanent
rejection in the client's ledger row, in a `rejections` column, so a replayed
copy of a rejected mutation reports the committed rejection and its reason. A
ledger created without that column fails each push with a `BackendError` that
names this migration, and that push writes nothing. Whatever version created your
ledger table (`sync_mutations`, or the `mutationsTable` you configured), check
whether it has the column, and add it only if it does not:

```sql
-- PostgreSQL: returns a row only when the column is already there
SELECT 1 FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'sync_mutations' AND column_name = 'rejections';

-- SQLite: returns a row only when the column is already there
SELECT 1 FROM pragma_table_info('sync_mutations') WHERE name = 'rejections';
```

If the check returns no row, add the column:

```sql
ALTER TABLE sync_mutations ADD COLUMN rejections TEXT;
```

On PostgreSQL, `ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS rejections TEXT;`
does the check and the change in one statement, and is safe to repeat. SQLite has
no `IF NOT EXISTS` for columns, so run the check first: the plain `ALTER TABLE`
fails with "duplicate column" on a ledger that already has the column.

The column is nullable and has no default, so existing rows are unchanged. It is
a metadata-only change on both databases, with a brief lock on the ledger table.

A new install creates the ledger with the column:

```sql
CREATE TABLE sync_mutations (
  client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
  rejections TEXT,
  PRIMARY KEY (client_group_id, client_id)
);
```

The `rejections` value is a JSON object that maps each remembered mutation id to
its reason. A push forgets the rejections below its lowest id per client, and a
client that never pushes again keeps its last push's rejections. A pull reports
the rejections its watermark covers, so a client whose push response was lost
settles those mutations as rejected (#365).

## Install

```sh
npm install @thomasfosterau/legation-sql @thomasfosterau/legation-effect effect
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.2` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR); install one copy of `effect` in your app (ADR-0003).

## License

MIT
