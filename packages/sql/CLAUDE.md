# packages/sql — `@thomasfosterau/legation-sql`

The SQL reference `Backend`. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Driver-agnostic: the backend runs over the tiny `SqlExecutor` seam (`query` / `run` / `transaction`, optional `transactional`); a driver is the consumer's choice. Imports from the workspace: `@thomasfosterau/legation-effect` only; `@effect/sql-*` drivers are test-only devDependencies.

## Invariants

- **The `WHERE` is exact on both dialects** (ADR-0028): every predicate node compiles to the three-valued expression `Predicate.evaluate` computes. `differential.test.ts` checks SQL against the in-memory evaluator.
- **The mutation-id ledger is transactional, idempotent and gap-checked** (`BackendContract`). On an executor without transactions (`transactional: false`, e.g. D1) the backend runs the handler and then bumps the id, not atomically, and Backend guarantee 1 does not hold (#342, #353).
- `sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test against a real server; it skips locally without `DATABASE_URL` and fails in CI without it.

## Tests

`src/__tests__/` (Vitest project `node`, SQLite through `@effect/sql-sqlite-node`, PGlite in the differential suite, PostgreSQL via `DATABASE_URL`).
