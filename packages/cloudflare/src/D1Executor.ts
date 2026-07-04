/**
 * D1Executor
 *
 * A `SqlBackend` executor over a Cloudflare D1 database — point
 * `SqlBackend.make({ executor: D1Executor.make(env.DB), ... })` at a D1
 * binding and the room's push/pull runs against it.
 *
 * **Transactions:** D1 exposes no interactive transactions (only
 * `batch()`), so `transaction` runs the effect as-is. The engine's
 * correctness story degrades gracefully — mutation ids make replays
 * idempotent-by-skip, so a mid-push failure retries without re-applying
 * acknowledged mutations — but a single mutation whose handler issues
 * several statements can commit partially on failure. Prefer
 * single-statement handlers (or app-level idempotency) on D1; Postgres
 * via Hyperdrive keeps full transactionality.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { BackendError } from "@legation/effect";
import type { SqlBackend, Sql } from "@legation/sql";

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
  // See the module doc: no interactive transactions on D1.
  transaction: (effect) => effect,
});
