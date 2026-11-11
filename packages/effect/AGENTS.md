# packages/effect — `@thomasfosterau/legation`

The engine core. Read the root [AGENTS.md](../../AGENTS.md) first; this file carries only what is specific to this package.

## Boundary

- **Peer: `effect` only.** Nothing here imports a runtime (`node:*`, DOM globals beyond the `WebWorker` lib), a protocol library or a framework (ADR-0006, ADR-0033). Code that needs one goes in its own package; `.fallowrc.json` gives this zone no allowed imports.
- **Three entries** (ADR-0022, ADR-0033): `src/index.ts` (`.`) is the app surface — `Node`, `Edge`, `Collection`, `Query`, `Mutator`, `Client`, `Server`, `Backend`, `Authorization`, the errors. `src/internal.ts` (`./internal`) is the engine seams for adapter authors — `ClientEngine`, `ClientStore`, `Subset`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo`, `Mirror*`, `Transport`, …. `src/sql/index.ts` (`./sql`) is the SQL reference backend — `Sql`, `SqlBackend`, `PgExecutor`, `PollingHintSource`. A new export goes on exactly one of them; moving one between them is a breaking change. Nothing outside `src/sql/` imports `src/sql/`, and the root and `./internal` barrels never re-export it, so an app without a database never loads it.
- The entries share bundle chunks (`vp pack`), so a value reached through more than one is the same instance. `src/sql/` imports the rest of the core through `../index.js` and `../internal.js`.

## Invariants

- **Writes are named, schema-validated intents** replayed on server state (rebase, ADR-0008); never merge row values.
- **The wire and storage formats are protocol.** `Protocol.ts`, `MirrorProtocol.ts`, the `ClientStore` key layout and journal records are read by other versions of the engine (other tabs, a persisted store); a field rename or shape change needs a migration and a changeset that says so.
- **`Predicate` here is the filter grammar** (ADR-0028), not `effect/Predicate`; import effect's as `P` where both are needed.
- **The `BackendContract` suite** (`BackendContract.ts`) is the normative backend behaviour: every `Backend` (memory, SQL, JSON:API) runs it in its tests.

## SQL backend (`./sql`)

- Driver-agnostic: the backend runs over the tiny `SqlExecutor` seam (`query` / `run` / `transaction`, optional `transactional`); a driver is the consumer's choice. `@effect/sql-*` drivers and `@effect/platform-node` are test-only devDependencies. `PgExecutor` imports `effect/sql/SqlClient`, which ships in the `effect` peer, so the PostgreSQL executor needs no dependency (#203): the driver that provides `SqlClient` is the app's.
- **The `WHERE` is exact on both dialects** (ADR-0028): every predicate node compiles to the three-valued expression `Predicate.evaluate` computes. `__tests__/sql/differential.test.ts` checks SQL against the in-memory evaluator.
- **The mutation-id ledger is transactional, idempotent and gap-checked** (`BackendContract`). On an executor without transactions (`transactional: false`, e.g. D1) the backend runs the handler and then bumps the id, not atomically, and Backend guarantee 1 does not hold (#342, #353).
- **`PgExecutor` statements run unprepared** and its `transaction` is one top-level `withTransaction`; `pg-executor.test.ts` asserts its round trips at the executor seam, and the PostgreSQL block of `backend-contract.test.ts` runs the conformance suite over it.
- **`evaluateMany` equals per-subset `evaluate`** (#505, `BackendContract` rule 14): one `UNION ALL` per pull, finished by the same code as `evaluate`. Its arms carry their rows per `Dialect.unionRows`: on SQLite the relation's own columns by position (`Columns`; names from `pragma_table_info`, cached per read relation for the backend's life), so values are the driver's; on PostgreSQL JSON (`Json`, `row_to_json`), with a fallback to per-subset `evaluate` when a row holds a number JSON cannot carry exactly (an integer past ±(2^53 − 1), more digits than a double, nested in `jsonb` too), logged once per collection and column as an `InexactJsonNumber` warning; integer, double and text values belong in typed columns, not JSON (owner decision on #505, 2026-10-24; no two-phase pull). `evaluate-many.test.ts` (SQLite), `evaluate-many-json.test.ts` (the `Json` path over canned rows) and `pg-executor.test.ts` (PostgreSQL) assert its statement count, the fallback and the warning.
- `sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test against a real server; it skips locally without `DATABASE_URL` and fails in CI without it.

## Tests

`src/__tests__/*.test.ts` (Vitest project `node`); the SQL backend's suites are `src/__tests__/sql/` (SQLite through `@effect/sql-sqlite-node`, PGlite in the differential suite, PostgreSQL via `DATABASE_URL`). Benchmarks are `*.bench.ts` (`vp run bench`, not a gate). `vp test run packages/effect` needs no build.
