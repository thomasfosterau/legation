---
"@thomasfosterau/legation-sql": minor
---

`SqlBackend` now guarantees serialisable isolation across client groups (Backend guarantee 1, #353). Two behaviour changes follow, and the `Sql.Dialect` interface gains an optional field.

- **PostgreSQL** (`Sql.postgres`): each `applyMutations` transaction runs `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` before its first read. A handler that read a row another transaction changed first is refused with SQLSTATE 40001, rolls back, and reports a transient `BackendError`, so the client's retry re-runs it on the committed state. Overlapping calls for one client group that READ COMMITTED would have let through now produce the same serialization failure, then skip on retry. **Action required** for PostgreSQL apps: a serialization failure must reach `SqlBackend` as a `BackendError`, as an executor built over `@effect/sql-pg` does. The client's retry of that batch is expected, not an error to report.
- **SQLite** is unchanged. Its writers already serialise (`BEGIN IMMEDIATE`), and it conforms.
- **D1** (`transactional: false`) does not conform, since it has no transactions to isolate. The README and the `D1Executor` docs now say so (#342).

`Sql.Dialect` gains an optional `serializable` statement, which `Sql.postgres` sets. The `SqlExecutor` seam docs state the isolation a third-party executor must provide.

**PostgreSQL apps must pass `dialect: Sql.postgres` to `SqlBackend.make`.** Without it the backend uses the SQLite dialect, which runs no isolation statement and raises no error, so batches run at READ COMMITTED. A hand-written dialect without a `serializable` statement gets no isolation statement either. Also, the executor's `transaction` must open a top-level transaction: PostgreSQL refuses `SET TRANSACTION` inside a nested one (a savepoint), and `applyMutations` then fails with a `BackendError` rather than running at a weaker isolation.
