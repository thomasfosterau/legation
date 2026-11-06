---
"@thomasfosterau/legation-cloudflare": minor
---

Depend on `@thomasfosterau/legation` only: the SQL reference backend that `D1Executor` implements the executor seam of is now `@thomasfosterau/legation/sql`, replacing the `@thomasfosterau/legation-sql` dependency. Import `SqlBackend` and `Sql` from `@thomasfosterau/legation/sql`.

`@cloudflare/workers-types` is now declared as an optional peer (`^5.0.0`). The package's declarations import the workerd types (`D1Database`, the Durable Object types, `WebSocket`) and always did; they had only been a devDependency, so a consumer was never told to install them.
