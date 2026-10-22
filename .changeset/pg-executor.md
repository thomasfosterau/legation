---
"@thomasfosterau/legation-sql": minor
---

Add `PgExecutor`, the `SqlExecutor` for PostgreSQL (#203). `PgExecutor.make(sql)`
runs `SqlBackend` over any PostgreSQL `SqlClient` from `effect/sql` (provided by
a driver such as `@effect/sql-pg`), with `dialect: Sql.postgres`. Each push is one
`withTransaction` at SERIALIZABLE, so a mutation's id claim commits with its
handler's writes; statements run unprepared, so nothing depends on a named
prepared statement surviving behind a transaction-mode pooler; and a failure is a
`BackendError` carrying the driver's `SqlError`. The package gains no dependency:
`effect/sql` ships in the `effect` peer. The README's new PostgreSQL section
covers the executor's round trips and what it needs from a pooler such as
Hyperdrive.
