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

Reads push the predicate to the database via `WHERE` and finalise
order/limit/cursor locally with `Subset.apply`. The `WHERE` is exact on both
dialects (ADR-0028): every node compiles to the three-valued expression
`Predicate.evaluate` computes, text comparisons carry an explicit code-point
collation (`COLLATE "C"` / `COLLATE BINARY`), and a table mapping's `kinds`
tell the compiler which columns are text, instants or booleans (SQLite stores
booleans as `0`/`1`; the backend decodes them back). Writes run app-authored
handlers inside one transaction with the per-client `lastMutationId` bump.

```bash
npm install @legation/sql @legation/effect effect
```
