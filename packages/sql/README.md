# @thomasfosterau/effect-sync-sql

A driver-agnostic SQL reference backend for the
[`@thomasfosterau/effect-sync-core`](../core) engine.

- **`Sql`** — a pure translator from a `Subset` predicate to a parameterized
  `WHERE` clause (and a full `SELECT`), with SQLite (`?`) and PostgreSQL (`$n`)
  dialects.
- **`SqlBackend`** — an implementation of the core `Backend` contract over a
  tiny `SqlExecutor` seam (`query` / `run` / `transaction`). Bring your own
  driver (`bun:sqlite`, `effect/unstable/sql`, `pg`, …); the backend supplies
  subset evaluation, row fetching, and the transactional, idempotent,
  gap-checked mutation-id ledger.

Reads push the predicate to the database via `WHERE` and finalize
order/limit/cursor locally with `Subset.apply` (the `WHERE` is a sound
superset). Writes run app-authored handlers inside one transaction with the
per-client `lastMutationId` bump.

```bash
npm install @thomasfosterau/effect-sync-sql @thomasfosterau/effect-sync-core effect
```
