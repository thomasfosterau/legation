/**
 * @legation/sql
 *
 * A driver-agnostic SQL reference backend for the legation engine: a pure
 * `Subset` predicate → `WHERE` translator (`Sql`) and a `Backend`
 * implementation over a tiny `SqlExecutor` seam (`SqlBackend`). Bring your own
 * driver (`bun:sqlite`, `effect/unstable/sql`, `pg`, …); the backend supplies
 * subset evaluation, row fetching, and the transactional mutation-id ledger.
 */

export * as Sql from "./Sql.js";
export * as SqlBackend from "./SqlBackend.js";
