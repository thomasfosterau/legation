---
"@legation/sql": minor
---

New package `@legation/sql`: a driver-agnostic SQL reference
backend. `Sql` translates a `Subset` predicate to a parameterized `WHERE`
(SQLite `?` and PostgreSQL `$n` dialects); `SqlBackend` implements the core
`Backend` contract over a minimal `SqlExecutor` seam (`query`/`run`/
`transaction`) — subset evaluation, row fetching by id, and a transactional,
idempotent, gap-checked mutation-id ledger — leaving the driver (`bun:sqlite`,
`effect/unstable/sql`, `pg`, …) to the app. Addresses the audit's turnkey-backend
gap (#23).
