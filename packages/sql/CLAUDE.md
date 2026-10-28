# packages/sql — `@thomasfosterau/legation-sql`

The SQL reference `Backend`. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Driver-agnostic: the backend runs over the tiny `SqlExecutor` seam (`query` / `run` / `transaction`, optional `transactional`); a driver is the consumer's choice. Imports from the workspace: `@thomasfosterau/legation-effect` only; `@effect/sql-*` drivers are test-only devDependencies. `PgExecutor` imports `effect/sql/SqlClient`, which ships in the `effect` peer, so the PostgreSQL executor lives here rather than in its own package (ADR-0006, #203): the driver that provides `SqlClient` is the app's.

## Invariants

- **The `WHERE` is exact on both dialects** (ADR-0028): every predicate node compiles to the three-valued expression `Predicate.evaluate` computes. `differential.test.ts` checks SQL against the in-memory evaluator.
- **The mutation-id ledger is transactional, idempotent and gap-checked** (`BackendContract`). On an executor without transactions (`transactional: false`, e.g. D1) the backend runs the handler and then bumps the id, not atomically, and Backend guarantee 1 does not hold (#342, #353).
- **`PgExecutor` statements run unprepared** and its `transaction` is one top-level `withTransaction`; `pg-executor.test.ts` asserts its round trips at the executor seam, and the PostgreSQL block of `backend-contract.test.ts` runs the conformance suite over it.
- **`evaluateMany` equals per-subset `evaluate`** (#505, `BackendContract` rule 14): one `UNION ALL` per pull, finished by the same code as `evaluate`. Its arms carry their rows per `Dialect.unionRows`: on SQLite the relation's own columns by position (`Columns`; names from `pragma_table_info`, cached per read relation for the backend's life), so values are the driver's; on PostgreSQL JSON (`Json`, `row_to_json`), with a fallback to per-subset `evaluate` when a row holds a number JSON cannot carry exactly (an integer past ±(2^53 − 1), more digits than a double, nested in `jsonb` too), logged once per collection and column as an `InexactJsonNumber` warning; integer, double and text values belong in typed columns, not JSON (owner decision on #505, 2026-10-24; no two-phase pull). `evaluate-many.test.ts` (SQLite), `evaluate-many-json.test.ts` (the `Json` path over canned rows) and `pg-executor.test.ts` (PostgreSQL) assert its statement count, the fallback and the warning.
- `sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test against a real server; it skips locally without `DATABASE_URL` and fails in CI without it.

## Tests

`src/__tests__/` (Vitest project `node`, SQLite through `@effect/sql-sqlite-node`, PGlite in the differential suite, PostgreSQL via `DATABASE_URL`).
