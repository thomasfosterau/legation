/**
 * D1Executor
 *
 * A `SqlBackend` executor over a Cloudflare D1 database — point
 * `SqlBackend.make({ executor: D1Executor.make(env.DB), ... })` at a D1
 * binding and the room's push/pull runs against it.
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

import type { D1Database } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { BackendError } from "@thomasfosterau/legation-effect";
import type { SqlBackend, Sql } from "@thomasfosterau/legation-sql";

const asBackendError = (operation: string) => (cause: unknown) =>
  new BackendError({ message: `D1 ${operation} failed`, cause });

/** Build the executor over a D1 binding. */
export const make = (db: D1Database): SqlBackend.SqlExecutor => ({
  query: (fragment: Sql.SqlFragment) =>
    Effect.tryPromise({
      try: async () => {
        const result = await db
          .prepare(fragment.text)
          .bind(...fragment.params)
          .all();
        return (result.results ?? []) as ReadonlyArray<SqlBackend.SqlRow>;
      },
      catch: asBackendError("query"),
    }),
  run: (fragment: Sql.SqlFragment) =>
    Effect.tryPromise({
      try: async () => {
        await db
          .prepare(fragment.text)
          .bind(...fragment.params)
          .run();
      },
      catch: asBackendError("run"),
    }),
  // See the module doc: no interactive transactions on D1, so the ledger's
  // claim-first order is not used (`transactional: false`).
  transaction: (effect) => effect,
  transactional: false,
});
