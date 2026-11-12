---
"@thomasfosterau/legation": patch
---

`PgExecutor.make` accepts a driver's own client as well as the `SqlClient` service (#687). It now takes `PgExecutor.Client`, the two members it uses (`Pick<SqlClient, "unsafe" | "withTransaction">`), so an `@effect/sql-pg` `PgClient` (a `db.$client`, say) type-checks on effect 4.1.3 and later, where a driver's client extends `SqlClient`'s `Base` without the `SqlClient` type id, as well as on 4.0.0 – 4.1.2.
