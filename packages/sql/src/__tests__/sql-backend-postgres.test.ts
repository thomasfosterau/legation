/**
 * SqlBackend's mutation-id ledger on a real PostgreSQL server (issue #360): the
 * READ COMMITTED overlap that #352 is about, run with two real transactions.
 * SQLite serialises its transactions and PGlite is one connection behind a
 * mutex, so neither can interleave two calls; the mock in `sql-backend.test.ts`
 * models the interleaving but not PostgreSQL's row locks. This file has none of
 * those gaps.
 *
 * The suite needs `DATABASE_URL`, a PostgreSQL URL for a database this test may
 * reset: it drops and recreates `todos`, `effects` and `sync_mutations`.
 * Without it, the suite is skipped locally with a warning. In CI (`CI` set) a
 * missing `DATABASE_URL` fails the suite instead, so it cannot skip silently.
 * The Quality Gates and Tests (effect floor) jobs run a PostgreSQL service
 * container and set the variable (see `.github/workflows/ci.yml`).
 */
import { describe, expect, it } from "@effect/vitest";
import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Backend, BackendError, Mutator } from "@thomasfosterau/legation-effect";
import * as Sql from "../Sql.js";
import * as SqlBackend from "../SqlBackend.js";

const databaseUrl = process.env.DATABASE_URL;

const CLIENT_GROUP = "g";
const CLIENT = "c1";
const context = { clientGroupId: CLIENT_GROUP };

const DDL: ReadonlyArray<string> = [
  `DROP TABLE IF EXISTS todos, effects, sync_mutations`,
  `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
  // One row per handler application, so a second application is visible.
  `CREATE TABLE effects (seq INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL)`,
  // The ledger's default table and columns (`SqlBackendConfig.mutationsTable`).
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** Run `use` on a pooled client against a freshly reset schema. */
const withDatabase = <A>(
  url: string,
  use: (sql: SqlClient) => Effect.Effect<A, unknown>
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Four connections: the first call's transaction, the copy's, and the
      // lock-wait poll, with one spare.
      const built = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
      );
      const sql = Context.get(built, SqlClient);
      for (const statement of DDL) yield* sql.unsafe(statement).unprepared;
      return yield* use(sql);
    })
  ).pipe(Effect.orDie);

const asBackendError = (message: string) => (cause: unknown) =>
  new BackendError({ message, cause });

/** A `SqlExecutor` over the PostgreSQL client: transactions are real and do not serialise. */
const executorOver = (sql: SqlClient): SqlBackend.SqlExecutor => ({
  query: (fragment) =>
    sql
      .unsafe<SqlBackend.SqlRow>(fragment.text, fragment.params)
      .pipe(Effect.mapError(asBackendError(`query failed: ${fragment.text}`))),
  run: (fragment) =>
    sql
      .unsafe(fragment.text, fragment.params)
      .pipe(Effect.asVoid, Effect.mapError(asBackendError(`statement failed: ${fragment.text}`))),
  transaction: (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (error) =>
          Effect.fail(new BackendError({ message: "transaction failed", cause: error }))
        )
      ),
});

interface Args {
  readonly id: string;
  readonly title: string;
}

const argsSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
const setTodo = Mutator.make("todo/set", argsSchema);
const parkTodo = Mutator.make("todo/park", argsSchema);

const mutation = (mutationId: number, mutator: string) => ({
  clientId: CLIENT,
  mutationId,
  mutator,
  args: { id: String(mutationId), title: `t${mutationId}` },
  createdAt: 0,
});

/**
 * A handler's non-idempotent write: a todo row plus one effect-log row for this
 * application. Returns the change hint a real handler would emit.
 */
const applyWrite = (tx: SqlBackend.SqlExecutor, args: Args) =>
  tx
    .run({
      text: `INSERT INTO todos (id, title) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
      params: [args.id, args.title],
    })
    .pipe(
      Effect.andThen(tx.run({ text: `INSERT INTO effects (id) VALUES ($1)`, params: [args.id] })),
      Effect.as<ReadonlyArray<Backend.ChangeHint>>([{ collection: "todos", ids: [args.id] }])
    );

/** The ledger's watermark for the test client (0 when it has no row). */
const ledgerOf = (sql: SqlClient) =>
  sql
    .unsafe<{ last_mutation_id: number }>(
      `SELECT last_mutation_id FROM sync_mutations WHERE client_group_id = $1 AND client_id = $2`,
      [CLIENT_GROUP, CLIENT]
    )
    .pipe(
      Effect.map((rows) => Number(rows[0]?.last_mutation_id ?? 0)),
      Effect.orDie
    );

/** How many times the handler for mutation `id` wrote its effect row. */
const applicationsOf = (sql: SqlClient, id: string) =>
  sql.unsafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM effects WHERE id = $1`, [id]).pipe(
    Effect.map((rows) => Number(rows[0]?.n ?? 0)),
    Effect.orDie
  );

/** How the copy of a mutation settled: it finished, or it is waiting on a lock for `statement`. */
type CopySettled =
  { readonly _tag: "Finished" } | { readonly _tag: "Blocked"; readonly statement: string };

/**
 * The statement another backend is waiting on a lock for, if any. A lock-wait
 * check on `pg_stat_activity`, not a sleep.
 */
const lockWaitOf = (sql: SqlClient) =>
  sql
    .unsafe<{ query: string }>(
      `SELECT query FROM pg_stat_activity ` +
        `WHERE datname = current_database() AND pid <> pg_backend_pid() ` +
        `AND wait_event_type = 'Lock' ORDER BY pid LIMIT 1`
    )
    .pipe(
      Effect.map((rows) => rows[0]?.query),
      Effect.orDie
    );

/**
 * Waits until the copy has either finished or is blocked on a lock, polling
 * every few milliseconds, and reports which. The polls are real I/O, so the
 * test runs with `it.live` (the real clock): under `it.effect`'s TestClock the
 * retry's delay would never elapse. Fails after twenty seconds with neither, so
 * a hang reads as a failure.
 */
const awaitCopySettled = (sql: SqlClient, copy: Fiber.Fiber<unknown, unknown>) =>
  Effect.gen(function* () {
    if (copy.pollUnsafe() !== undefined) return { _tag: "Finished" } as CopySettled;
    const statement = yield* lockWaitOf(sql);
    if (statement !== undefined) return { _tag: "Blocked", statement } as CopySettled;
    return yield* Effect.fail("pending" as const);
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("5 millis"),
      while: (state) => state === "pending",
    }),
    Effect.timeout("20 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.die(new Error("the copy neither blocked on a lock nor finished within 20s"))
    )
  );

// Always runs, so a CI job without the service fails here instead of skipping
// the suite below in silence.
it("has DATABASE_URL in CI, so the PostgreSQL overlap test cannot skip silently", () => {
  const ciWithoutDatabase = process.env.CI !== undefined && databaseUrl === undefined;
  expect(
    ciWithoutDatabase,
    "DATABASE_URL is not set in CI: the PostgreSQL overlap test (#360) needs the " +
      "PostgreSQL service container in .github/workflows/ci.yml"
  ).toBe(false);
});

if (databaseUrl === undefined && process.env.CI === undefined) {
  process.stderr.write(
    "\n*** [sql-backend-postgres] SKIPPED: DATABASE_URL is not set, so the PostgreSQL " +
      "READ COMMITTED overlap test (#360) did not run. Point DATABASE_URL at a " +
      "scratch PostgreSQL database to run it. ***\n\n"
  );
}

const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("SqlBackend on PostgreSQL: overlapping calls (READ COMMITTED, #352, #360)", () => {
  const url = databaseUrl ?? "";

  // `it.live`, not `it.effect`: the copy's lock wait is observed by polling a
  // real server, so the test runs on the real clock (CONTRIBUTING, "Tests").
  it.live(
    "a copy of a mutation in flight blocks on the first call's claim, then skips; the handler applies once",
    () =>
      withDatabase(url, (sql) =>
        Effect.gen(function* () {
          // The first call's handler writes, then parks inside its transaction
          // (holding its claim row) until the test releases it.
          const parked = yield* Ref.make(false);
          const written = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const backend = SqlBackend.make({
            executor: executorOver(sql),
            tables: { todos: { table: "todos" } },
            mutators: new Map<string, Mutator.AnyMutator>([
              [setTodo.name, setTodo],
              [parkTodo.name, parkTodo],
            ]),
            handlers: {
              "todo/set": (raw, tx) => applyWrite(tx, raw as Args),
              "todo/park": (raw, tx) =>
                Effect.gen(function* () {
                  const hints = yield* applyWrite(tx, raw as Args);
                  if (!(yield* Ref.getAndSet(parked, true))) {
                    yield* Deferred.succeed(written, undefined);
                    yield* Deferred.await(release);
                  }
                  return hints;
                }),
            },
            dialect: Sql.postgres,
          });

          yield* backend.applyMutations(context, [mutation(1, "todo/set")]);

          const first = yield* Effect.forkChild(
            backend.applyMutations(context, [mutation(2, "todo/park")])
          );
          // Surfaces the first call's own failure instead of waiting for a
          // signal that would never come.
          yield* Effect.raceFirst(Deferred.await(written), Fiber.join(first));

          // The copy of mutation 2 runs while the first call is parked after its
          // claim: its ledger statements wait on that uncommitted row.
          const copy = yield* Effect.forkChild(
            backend.applyMutations(context, [mutation(2, "todo/park")])
          );
          // Captured, not raised: the parked call must be released either way.
          const copySettled = yield* Effect.exit(awaitCopySettled(sql, copy));

          yield* Deferred.succeed(release, undefined);
          const applied = yield* Fiber.join(first);
          const skipped = yield* Fiber.join(copy);

          // The handler applied mutation 2 exactly once, and the ledger stayed
          // at 2 (monotonic): the copy neither applied it nor moved it back.
          expect(yield* applicationsOf(sql, "2")).toBe(1);
          expect(yield* ledgerOf(sql)).toBe(2);
          expect(applied.lastMutationIds).toEqual({ [CLIENT]: 2 });
          expect(skipped.lastMutationIds).toEqual({ [CLIENT]: 2 });
          expect(skipped.hints).toEqual([]);

          // The ledger still advances after the overlap.
          const next = yield* backend.applyMutations(context, [mutation(3, "todo/set")]);
          expect(next.lastMutationIds).toEqual({ [CLIENT]: 3 });

          // The copy waited on the first call's claim row (it did not finish
          // ahead of it). Asserted last, so a failure above names the double
          // application or the moved watermark first.
          expect(copySettled).toEqual(
            Exit.succeed({
              _tag: "Blocked",
              statement: expect.stringContaining(`"sync_mutations"`),
            })
          );
        })
      ),
    60_000
  );
});
