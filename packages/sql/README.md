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
