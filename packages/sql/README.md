# @legation/sql

A driver-agnostic SQL reference backend for the
[`@legation/effect`](../core) engine.

- **`Sql`** — a pure translator from a `Subset` predicate to a parameterized
  `WHERE` clause (and a full `SELECT`), with SQLite (`?`) and PostgreSQL (`$n`)
  dialects.
- **`SqlBackend`** — an implementation of the core `Backend` contract over a
  tiny `SqlExecutor` seam (`query` / `run` / `transaction`). Bring your own
  driver (`bun:sqlite`, `effect/unstable/sql`, `pg`, …); the backend supplies
  subset evaluation, row fetching, and the transactional, idempotent,
  gap-checked mutation-id ledger.
- **`PollingHintSource`** — a tier-2 change-data-capture hint source over the
  same `SqlExecutor` seam: it polls each table on an interval for a cheap
  change-detector (`COUNT(*)` plus `MAX(versionColumn)`) and pokes subscribers
  when a collection changes out of band (cron, admin tools, `psql`). See the
  [change-data-capture guide](../../docs/change-data-capture.md).

Reads push the predicate to the database via `WHERE` and finalize
order/limit/cursor locally with `Subset.apply` (the `WHERE` is a sound
superset). Writes run app-authored handlers inside one transaction with the
per-client `lastMutationId` bump.

```bash
npm install @legation/sql @legation/effect effect
```
