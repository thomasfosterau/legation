/**
 * D1Executor
 *
 * A `SqlBackend` executor over Alchemy's Effect-native D1 client: point
 * `SqlBackend.make({ executor, ... })` at the `QueryDatabaseClient` that
 * `Cloudflare.D1.QueryDatabase(database)` binds, and the room's push/pull runs
 * against it. Statements go through the client's `prepare` / `bind` / `all` /
 * `run`, so the database is bound, named and typed the way the rest of an
 * Alchemy Worker binds it.
 *
 * The client's statements need Alchemy's `RuntimeContext` (they run only
 * inside a Worker or Durable Object event); {@link make} captures it once, so
 * the executor it returns needs nothing. The client reports a failed statement
 * as a defect (its effects have no error channel); the executor turns that
 * defect into a `BackendError`.
 *
 * **Transactions:** D1 exposes no interactive transactions (only `batch()`),
 * so `transaction` runs the effect as-is and the executor sets
 * `transactional: false`. `SqlBackend` then keeps trunk's order on D1: each
 * handler runs, then its mutation id is bumped, and the bump is not atomic with
 * the handler's writes. A pull between the two can carry a mutation's effect
 * without its watermark, and a crash after the writes and before the bump
 * makes the retry run the handler again, so a non-idempotent handler can apply
 * twice. A transient failure also leaves the handler's writes committed. D1
 * has no isolation either, so a handler's reads are not protected from another
 * client group's commit, and an increment can be lost (#353). This does not
 * meet Backend guarantee 1 (#342, #353). Apps that need that guarantee should
 * use Durable Object storage or Postgres via Hyperdrive; on D1, prefer
 * single-statement, idempotent handlers.
 */

import type { QueryDatabaseClient } from "@alchemy.run/cloudflare/D1";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { BackendError } from "@thomasfosterau/legation";
import type { SqlBackend, Sql } from "@thomasfosterau/legation/sql";

/**
 * Build the executor over a bound D1 client. Needs the `RuntimeContext` of the
 * Worker or Durable Object it runs in (the inner, per-instance phase of an
 * Alchemy Durable Object has it).
 */
export const make = (
  db: QueryDatabaseClient
): Effect.Effect<SqlBackend.SqlExecutor, never, RuntimeContext> =>
  Effect.map(Effect.service(RuntimeContext), (runtime) => {
    /** Run one statement with the captured context; a failed statement is a `BackendError`. */
    const execute = <A>(operation: string, statement: Effect.Effect<A, never, RuntimeContext>) =>
      statement.pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.catchDefect((cause) =>
          Effect.fail(new BackendError({ message: `D1 ${operation} failed`, cause }))
        )
      );
    return {
      query: (fragment: Sql.SqlFragment) =>
        execute(
          "query",
          db
            .prepare(fragment.text)
            .bind(...fragment.params)
            .all<SqlBackend.SqlRow>()
        ).pipe(Effect.map((result): ReadonlyArray<SqlBackend.SqlRow> => result.results ?? [])),
      run: (fragment: Sql.SqlFragment) =>
        execute(
          "run",
          db
            .prepare(fragment.text)
            .bind(...fragment.params)
            .run()
        ).pipe(Effect.asVoid),
      // See the module doc: no interactive transactions on D1, so the ledger's
      // claim-first order is not used (`transactional: false`).
      transaction: (effect) => effect,
      transactional: false,
    };
  });
