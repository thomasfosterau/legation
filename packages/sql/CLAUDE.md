# packages/sql — `@thomasfosterau/legation-sql`

The SQL reference `Backend`. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Driver-agnostic: the backend runs over the tiny `SqlExecutor` seam (`query` / `run` / `transaction`, optional `transactional`); a driver is the consumer's choice. Imports from the workspace: `@thomasfosterau/legation-effect` only; `@effect/sql-*` drivers are test-only devDependencies. `PgExecutor` imports `effect/sql/SqlClient`, which ships in the `effect` peer, so the PostgreSQL executor lives here rather than in its own package (ADR-0006, #203): the driver that provides `SqlClient` is the app's.

## Invariants

- **The `WHERE` is exact on both dialects** (ADR-0028): every predicate node compiles to the three-valued expression `Predicate.evaluate` computes. `differential.test.ts` checks SQL against the in-memory evaluator.
- **The mutation-id ledger is transactional, idempotent and gap-checked** (`BackendContract`). On an executor without transactions (`transactional: false`, e.g. D1) the backend runs the handler and then bumps the id, not atomically, and Backend guarantee 1 does not hold (#342, #353).
- **`PgExecutor` statements run unprepared** and its `transaction` is one top-level `withTransaction`; `pg-executor.test.ts` asserts its round trips at the executor seam, and the PostgreSQL block of `backend-contract.test.ts` runs the conformance suite over it.
- **`evaluateMany` equals per-subset `evaluate`** (#505, `BackendContract` rule 14): one `UNION ALL` per pull whose arms carry their rows as JSON (`Dialect.rowJson`; SQLite's `json_object` reads its keys through `Dialect.columnsOf`, cached per read relation for the backend's life), finished by the same code as `evaluate`. `evaluate-many.test.ts` (SQLite) and `pg-executor.test.ts` (PostgreSQL) assert its statement count.
- `sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test against a real server; it skips locally without `DATABASE_URL` and fails in CI without it.

## Tests

`src/__tests__/` (Vitest project `node`, SQLite through `@effect/sql-sqlite-node`, PGlite in the differential suite, PostgreSQL via `DATABASE_URL`).
