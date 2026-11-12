/**
 * The client `PgExecutor.make` accepts (#687): the generic `SqlClient` service
 * and a driver's own client both, on every effect 4 release. From effect 4.1.3 a
 * driver client (`@effect/sql-pg`'s `PgClient`, `@effect/sql-sqlite-node`'s
 * `SqliteClient`) extends `SqlClient`'s `Base` without the `SqlClient` type id,
 * so a parameter typed `SqlClient` refused it.
 *
 * The type assertions are compile-time (`vp run check`, and the effect-floor
 * job at 4.0.0 / 4.1.0). The runtime case runs the executor over SQLite, whose
 * layer provides both services, so it needs no database server; the
 * PostgreSQL round trips are `pg-executor.test.ts`.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/sql/SqlClient";
import { BackendError } from "@thomasfosterau/legation";
import * as PgExecutor from "../../sql/PgExecutor.js";
import type * as SqlBackend from "../../sql/SqlBackend.js";

/**
 * An executor over each client, each typed as its interface, as an app holds it (`db.$client`), not as
 * the service tag's value, which intersects the driver's client with `SqlClient`; only ever type-checked.
 */
const overEach = (pg: PgClient.PgClient, sqlite: SqliteClient.SqliteClient, sql: SqlClient) => [
  PgExecutor.make(pg),
  PgExecutor.make(sqlite),
  PgExecutor.make(sql),
];

describe("PgExecutor.make's client (#687)", () => {
  it("accepts the generic SqlClient service and the drivers' own clients", () => {
    expectTypeOf<SqlClient>().toExtend<PgExecutor.Client>();
    expectTypeOf<PgClient.PgClient>().toExtend<PgExecutor.Client>();
    expectTypeOf<SqliteClient.SqliteClient>().toExtend<PgExecutor.Client>();
    expectTypeOf(PgExecutor.make).parameter(0).toEqualTypeOf<PgExecutor.Client>();
    expectTypeOf(overEach).returns.toEqualTypeOf<Array<SqlBackend.SqlExecutor>>();
  });

  it.effect("runs over a driver's own client as over the generic service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const built = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
        // Widened to the driver's interface: the service tag's value also carries `SqlClient`.
        const client: SqliteClient.SqliteClient = Context.get(built, SqliteClient.SqliteClient);
        const driver = PgExecutor.make(client);
        const generic = PgExecutor.make(Context.get(built, SqlClient));
        const executors: ReadonlyArray<SqlBackend.SqlExecutor> = [driver, generic];
        yield* driver.run({ text: "CREATE TABLE t (id TEXT PRIMARY KEY)", params: [] });
        yield* generic.transaction(
          generic.run({ text: "INSERT INTO t (id) VALUES (?)", params: ["a"] })
        );
        const rolledBack = yield* driver
          .transaction(
            driver
              .run({ text: "INSERT INTO t (id) VALUES (?)", params: ["b"] })
              .pipe(Effect.andThen(Effect.fail(new BackendError({ message: "abort" }))))
          )
          .pipe(Effect.flip);
        expect(rolledBack.message).toBe("abort");
        const rows = yield* Effect.forEach(
          executors,
          (executor) => executor.query({ text: "SELECT id FROM t ORDER BY id", params: [] }),
          { concurrency: 1 }
        );
        expect(rows).toEqual([[{ id: "a" }], [{ id: "a" }]]);
      })
    ).pipe(Effect.orDie)
  );
});
