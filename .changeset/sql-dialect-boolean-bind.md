---
"@thomasfosterau/legation": patch
---

`Sql.Dialect.boolean` (on `@thomasfosterau/legation/sql`) is typed `(value: boolean) => boolean | number` instead of returning `unknown`: the bind value is a boolean (PostgreSQL) or `0`/`1` (SQLite), as the two shipped dialects already return.
