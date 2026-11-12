/**
 * PgExecutor
 *
 * A `SqlBackend` executor over a PostgreSQL `SqlClient` from `effect/sql`
 * (#203). Pair it with `dialect: Sql.postgres`:
 *
 * ```ts
 * const sql = yield* SqlClient; // from `PgClient.layer(...)` (`@effect/sql-pg`)
 * const backend = SqlBackend.make({
 *   executor: PgExecutor.make(sql),
 *   dialect: Sql.postgres,
 *   tables,
 *   mutators,
 *   handlers,
 * });
 * ```
 *
 * The executor needs only two members of an `effect/sql` client (`Client`),
 * whose types ship in `effect` itself, so this package gains no dependency
 * (ADR-0006): the driver (`@effect/sql-pg`) and its connection settings are the
 * app's choice, and it provides the client. Either the generic `SqlClient`
 * service or the driver's own (`PgClient`) will do.
 *
 * **Transactions:** `transaction` is the client's `withTransaction`, so each
 * mutation batch is one real PostgreSQL transaction on one connection, and
 * `SqlBackend` claims each mutation id in the same transaction as its handler's
 * writes. `Sql.postgres` sets SERIALIZABLE as the transaction's first
 * statement, so a handler that read a row another transaction then changed is
 * refused with SQLSTATE 40001 and rolled back; that surfaces as a
 * `BackendError`, which the client retries. The transaction must be top-level:
 * calling the backend inside an outer `withTransaction` makes this a savepoint,
 * where PostgreSQL refuses `SET TRANSACTION` and the batch fails instead.
 *
 * **Statements run unprepared** (`.unprepared`): each is parsed per call rather
 * than cached by name on the connection. A transaction-mode pooler in front of
 * the database (PgBouncer, a managed pooler) can hand consecutive statements to
 * different server connections, where a named statement prepared on one does not
 * exist on the next. The cost is a parse per statement.
 */

import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { BackendError } from "../index.js";
import type * as Sql from "./Sql.js";
import type * as SqlBackend from "./SqlBackend.js";

const asBackendError = (message: string) => (cause: unknown) =>
  new BackendError({ message, cause });

/**
 * The members of an `effect/sql` client the executor uses: `unsafe` statements and `withTransaction`.
 *
 * Structural, so the driver's own client is accepted as well as the generic `SqlClient` service: from
 * effect 4.1.3 a driver client such as `@effect/sql-pg`'s `PgClient` extends `SqlClient`'s `Base`,
 * without the `SqlClient` type id, and is no longer a `SqlClient` (#687). Both members have the same
 * type on every effect 4 release.
 */
export type Client = Pick<SqlClient, "unsafe" | "withTransaction">;

/**
 * The executor over `sql`: unprepared statements, and a real transaction per `transaction` call.
 *
 * A failed statement or transaction fails as a `BackendError` that carries the driver's `SqlError`
 * as its `cause` (a serialization refusal included), with the statement text, never its parameters,
 * in the message.
 */
export const make = (sql: Client): SqlBackend.SqlExecutor => ({
  query: (fragment: Sql.SqlFragment) =>
    sql
      .unsafe<SqlBackend.SqlRow>(fragment.text, fragment.params)
      .unprepared.pipe(Effect.mapError(asBackendError(`query failed: ${fragment.text}`))),
  run: (fragment: Sql.SqlFragment) =>
    sql
      .unsafe(fragment.text, fragment.params)
      .unprepared.pipe(
        Effect.asVoid,
        Effect.mapError(asBackendError(`statement failed: ${fragment.text}`))
      ),
  // `BEGIN`, `COMMIT` and `ROLLBACK` fail as a `SqlError`; the effect's own failures are already
  // `BackendError`s. A serialization failure can surface at `COMMIT`, so it is mapped here too.
  transaction: (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (error) =>
          Effect.fail(asBackendError("transaction failed")(error))
        )
      ),
});
