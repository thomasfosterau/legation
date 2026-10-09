/**
 * SqlBackend's mutation-id ledger on a real SQLite connection (issue #352).
 * A mutation is claimed (a conditional UPDATE from `id - 1` to `id`) before its
 * handler runs, so a replay or a stale copy is skipped rather than applied
 * again, and a claim is rolled back with the handler's effects when a
 * transient error aborts the batch.
 *
 * SQLite serialises every transaction on its one connection (the client holds
 * a semaphore and takes the write lock with `BEGIN IMMEDIATE`), so overlapping
 * calls cannot interleave here. The READ COMMITTED interleaving that #352 is
 * about is modelled in `sql-backend.test.ts`, where the executor's transaction
 * does not serialise.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql/SqlClient";
import { Backend, BackendError, MutationRejected, Mutator } from "@thomasfosterau/legation-effect";
import * as SqlBackend from "../SqlBackend.js";

const CLIENT_GROUP = "g";
const CLIENT = "c1";

/** The schema a new install creates: the ledger with its `rejections` column (#366). */
const DDL: ReadonlyArray<string> = [
  `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT)`,
  // A log of every write a handler made: one row per application, so a second
  // application of the same mutation is visible as a second row.
  `CREATE TABLE effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** The schema before #366: the ledger has no `rejections` column. */
const DDL_BEFORE_366: ReadonlyArray<string> = [
  `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT)`,
  `CREATE TABLE effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** Run `use` against a fresh in-memory SQLite database with the given schema (default: `DDL`). */
const withDatabase = <A>(
  use: (sql: SqlClient) => Effect.Effect<A, unknown>,
  schema: ReadonlyArray<string> = DDL
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
      const sql = Context.get(context, SqlClient);
      for (const statement of schema) yield* sql.unsafe(statement).unprepared;
      return yield* use(sql);
    })
  );

const asBackendError = (message: string) => (cause: unknown) =>
  new BackendError({ message, cause });

/** `SqlExecutor` over the sqlite client; `transactional: false` mimics D1 (no transactions). */
const makeExecutor = (sql: SqlClient, transactional: boolean): SqlBackend.SqlExecutor => {
  return {
    query: (fragment) =>
      sql
        .unsafe<SqlBackend.SqlRow>(fragment.text, fragment.params)
        .pipe(Effect.mapError(asBackendError(`query failed: ${fragment.text}`))),
    run: (fragment) =>
      sql
        .unsafe(fragment.text, fragment.params)
        .pipe(Effect.asVoid, Effect.mapError(asBackendError(`statement failed: ${fragment.text}`))),
    transaction: transactional
      ? (effect) =>
          sql
            .withTransaction(effect)
            .pipe(
              Effect.catchTag("SqlError", (error) =>
                Effect.fail(new BackendError({ message: "transaction failed", cause: error }))
              )
            )
      : (effect) => effect,
    transactional,
  };
};

interface Args {
  readonly id: string;
  readonly title: string;
}

const argsSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
const mutatorNames = ["todo/set", "todo/park", "todo/observe", "todo/reject"] as const;
const mutators = new Map<string, Mutator.AnyMutator>(
  mutatorNames.map((name) => [name, Mutator.make(name, argsSchema)])
);

const mutation = (mutationId: number, mutator: string = "todo/set") => ({
  clientId: CLIENT,
  mutationId,
  mutator,
  args: { id: String(mutationId), title: `t${mutationId}` },
  createdAt: 0,
});

/** A handler's non-idempotent write: a todo row plus one effect-log row. */
const applyWrite = (tx: SqlBackend.SqlExecutor, args: Args) =>
  tx
    .run({
      text: `INSERT OR REPLACE INTO todos (id, title) VALUES (?, ?)`,
      params: [args.id, args.title],
    })
    .pipe(
      Effect.andThen(tx.run({ text: `INSERT INTO effects (id) VALUES (?)`, params: [args.id] })),
      Effect.as<ReadonlyArray<Backend.ChangeHint>>([{ collection: "todos", ids: [args.id] }])
    );

const backendWith = (
  sql: SqlClient,
  handlers: Record<string, SqlBackend.SqlHandler>,
  transactional = true
): Backend.Backend =>
  SqlBackend.make({
    executor: makeExecutor(sql, transactional),
    tables: { todos: { table: "todos" } },
    mutators,
    handlers,
  });

/** The ledger's watermark for the test client (0 when it has no row). */
const ledgerOf = (sql: SqlClient) =>
  sql
    .unsafe<{ last_mutation_id: number }>(
      `SELECT last_mutation_id FROM sync_mutations WHERE client_group_id = ? AND client_id = ?`,
      [CLIENT_GROUP, CLIENT]
    )
    .pipe(
      Effect.map((rows) => rows[0]?.last_mutation_id ?? 0),
      Effect.orDie
    );

const countOf = (sql: SqlClient, table: string) =>
  sql.unsafe<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
    Effect.map((rows) => rows[0]?.n ?? 0),
    Effect.orDie
  );

const context = { clientGroupId: CLIENT_GROUP };

describe("SqlBackend ledger on SQLite (issue #352)", () => {
  it.effect(
    "two overlapping calls for one mutation apply it once and the ledger stays monotonic",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const written = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const backend = backendWith(sql, {
            // Writes, then parks inside the transaction until released.
            "todo/park": (raw, tx) =>
              applyWrite(tx, raw as Args).pipe(
                Effect.tap(() => Deferred.succeed(written, undefined)),
                Effect.tap(() => Deferred.await(release))
              ),
          });

          const first = yield* Effect.forkChild(
            backend.applyMutations(context, [mutation(1, "todo/park")])
          );
          yield* Deferred.await(written);
          // A retry of the same mutation while the first push is still in flight.
          const copy = yield* Effect.forkChild(
            backend.applyMutations(context, [mutation(1, "todo/park")])
          );
          yield* Deferred.succeed(release, undefined);

          const applied = yield* Fiber.join(first);
          const skipped = yield* Fiber.join(copy);
          expect(applied.lastMutationIds).toEqual({ [CLIENT]: 1 });
          expect(skipped.lastMutationIds).toEqual({ [CLIENT]: 1 });
          expect(skipped.hints).toEqual([]);
          expect(yield* countOf(sql, "effects")).toBe(1);
          expect(yield* ledgerOf(sql)).toBe(1);
        })
      )
  );

  it.effect("a claim the ledger already covers is a replay that leaves the watermark alone", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const ran = yield* Ref.make(0);
        const backend = backendWith(sql, {
          "todo/set": (raw, tx) =>
            Ref.update(ran, (n) => n + 1).pipe(Effect.andThen(applyWrite(tx, raw as Args))),
        });
        yield* backend.applyMutations(context, [mutation(1), mutation(2)]);
        expect(yield* ledgerOf(sql)).toBe(2);

        // A stale copy of mutation 1 arrives after the ledger moved past it: its
        // claim (from 0) matches no row, the ledger reads 2, and it is skipped.
        const stale = yield* backend.applyMutations(context, [mutation(1)]);
        expect(stale.lastMutationIds).toEqual({ [CLIENT]: 2 });
        expect(yield* Ref.get(ran)).toBe(2);
        expect(yield* ledgerOf(sql)).toBe(2);
      })
    )
  );

  it.effect("the claim is taken before the handler runs", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const observed = yield* Ref.make(-1);
        const backend = backendWith(sql, {
          // Reads the ledger from inside the handler's transaction: the claim for
          // this mutation must already be there.
          "todo/observe": (raw, tx) =>
            tx
              .query({
                text: `SELECT last_mutation_id FROM sync_mutations WHERE client_group_id = ? AND client_id = ?`,
                params: [CLIENT_GROUP, CLIENT],
              })
              .pipe(
                Effect.flatMap((rows) => Ref.set(observed, Number(rows[0]?.last_mutation_id ?? 0))),
                Effect.andThen(applyWrite(tx, raw as Args))
              ),
        });
        yield* backend.applyMutations(context, [mutation(1, "todo/observe")]);
        expect(yield* Ref.get(observed)).toBe(1);
      })
    )
  );

  it.effect("a transient failure rolls the claim back with the handler's writes", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const failing = yield* Ref.make(true);
        const backend = backendWith(sql, {
          // Writes, then fails transiently while `failing` is set.
          "todo/set": (raw, tx) =>
            applyWrite(tx, raw as Args).pipe(
              Effect.tap(() =>
                Ref.get(failing).pipe(
                  Effect.flatMap((fail) =>
                    fail ? Effect.fail(new BackendError({ message: "transient" })) : Effect.void
                  )
                )
              )
            ),
        });

        const error = yield* backend.applyMutations(context, [mutation(1)]).pipe(Effect.flip);
        expect(error).toBeInstanceOf(BackendError);
        expect(yield* ledgerOf(sql)).toBe(0);
        expect(yield* countOf(sql, "effects")).toBe(0);
        expect(yield* countOf(sql, "todos")).toBe(0);

        // The client's retry now applies the mutation exactly once.
        yield* Ref.set(failing, false);
        const retried = yield* backend.applyMutations(context, [mutation(1)]);
        expect(retried.lastMutationIds).toEqual({ [CLIENT]: 1 });
        expect(yield* countOf(sql, "effects")).toBe(1);
      })
    )
  );

  it.effect("a permanent rejection keeps the claim and drops only the handler's writes", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const backend = backendWith(sql, {
          "todo/set": (raw, tx) => applyWrite(tx, raw as Args),
          "todo/reject": (raw, tx) =>
            applyWrite(tx, raw as Args).pipe(
              Effect.andThen(Effect.fail(new MutationRejected({ reason: "forbidden" })))
            ),
        });
        const result = yield* backend.applyMutations(context, [
          mutation(1, "todo/reject"),
          mutation(2),
        ]);
        expect(result.lastMutationIds).toEqual({ [CLIENT]: 2 });
        expect(result.rejected).toEqual([{ clientId: CLIENT, mutationId: 1, reason: "forbidden" }]);
        expect(yield* countOf(sql, "effects")).toBe(1);
        expect(yield* countOf(sql, "todos")).toBe(1);
        expect(yield* ledgerOf(sql)).toBe(2);
      })
    )
  );

  it.effect(
    "on an executor without transactions a re-sent applied mutation writes no second effect",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const backend = backendWith(
            sql,
            { "todo/set": (raw, tx) => applyWrite(tx, raw as Args) },
            false
          );
          const first = yield* backend.applyMutations(context, [mutation(1)]);
          expect(first.lastMutationIds).toEqual({ [CLIENT]: 1 });
          expect(yield* countOf(sql, "effects")).toBe(1);

          // The replay is covered by the ledger: its handler does not run again.
          const replay = yield* backend.applyMutations(context, [mutation(1)]);
          expect(replay.lastMutationIds).toEqual({ [CLIENT]: 1 });
          expect(replay.hints).toEqual([]);
          expect(yield* countOf(sql, "effects")).toBe(1);
          expect(yield* ledgerOf(sql)).toBe(1);
        })
      )
  );

  it.effect("on an executor without transactions a late bump never moves the watermark back", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        // Mutation 2's handler, mid-run, lets an overlapping call apply a copy of
        // 2 and then 3 on the same connection. The outer call's bump of 2 then
        // lands after 3's, and the watermark must stay at 3 (MAX on SQLite).
        let backend: Backend.Backend | undefined;
        const nested = yield* Ref.make(false);
        const outer = yield* Effect.sync(() =>
          backendWith(
            sql,
            {
              "todo/set": (raw, tx) => {
                const args = raw as Args;
                return Effect.gen(function* () {
                  if (args.id === "2" && !(yield* Ref.getAndSet(nested, true))) {
                    yield* backend!.applyMutations(context, [mutation(2), mutation(3)]);
                  }
                  return yield* applyWrite(tx, args);
                });
              },
            },
            false
          )
        );
        backend = outer;

        const result = yield* outer.applyMutations(context, [mutation(1), mutation(2)]);
        expect(result.lastMutationIds).toEqual({ [CLIENT]: 3 });
        expect(yield* ledgerOf(sql)).toBe(3);
      })
    )
  );

  it.effect(
    "on an executor without transactions a transient failure leaves the watermark alone",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const failing = yield* Ref.make(true);
          // D1-shaped: no transaction, so the handler's writes commit with each
          // statement and the id is bumped only after the handler.
          const backend = backendWith(
            sql,
            {
              "todo/set": (raw, tx) =>
                Ref.get(failing).pipe(
                  Effect.flatMap((fail) =>
                    fail
                      ? Effect.fail(new BackendError({ message: "transient" }))
                      : applyWrite(tx, raw as Args)
                  )
                ),
            },
            false
          );

          const error = yield* backend.applyMutations(context, [mutation(1)]).pipe(Effect.flip);
          expect(error).toBeInstanceOf(BackendError);
          // The handler failed before the bump, so the watermark is where it was.
          expect(yield* ledgerOf(sql)).toBe(0);

          yield* Ref.set(failing, false);
          const retried = yield* backend.applyMutations(context, [mutation(1)]);
          expect(retried.lastMutationIds).toEqual({ [CLIENT]: 1 });
          expect(yield* countOf(sql, "effects")).toBe(1);
        })
      )
  );

  it.effect("a gap is a BackendError and leaves the ledger unchanged", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const backend = backendWith(sql, { "todo/set": (raw, tx) => applyWrite(tx, raw as Args) });
        const error = yield* backend.applyMutations(context, [mutation(2)]).pipe(Effect.flip);
        expect(error).toBeInstanceOf(BackendError);
        expect(yield* ledgerOf(sql)).toBe(0);
        expect(yield* countOf(sql, "effects")).toBe(0);
      })
    )
  );
});

/**
 * A rejecting handler: it writes, then fails permanently with a reason that
 * names its mutation, so a test can tell which rejection a response reports.
 */
const rejectingHandlers: Record<string, SqlBackend.SqlHandler> = {
  "todo/set": (raw, tx) => applyWrite(tx, raw as Args),
  "todo/reject": (raw, tx) => {
    const args = raw as Args;
    return applyWrite(tx, args).pipe(
      Effect.andThen(Effect.fail(new MutationRejected({ reason: `forbidden ${args.id}` })))
    );
  },
};

const rejected = (mutationId: number) => ({
  clientId: CLIENT,
  mutationId,
  reason: `forbidden ${mutationId}`,
});

describe("SqlBackend rejection memory on SQLite (#366)", () => {
  it.effect("a replayed copy of a committed rejection reports it with its stored reason", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const backend = backendWith(sql, rejectingHandlers);
        const first = yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);
        expect(first.rejected).toEqual([rejected(1)]);

        // A retry after a lost response: no effects, and the committed outcome.
        const replay = yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);
        expect(replay.rejected).toEqual([rejected(1)]);
        expect(replay.hints).toEqual([]);
        expect(replay.lastMutationIds).toEqual({ [CLIENT]: 1 });
        expect(yield* countOf(sql, "effects")).toBe(0);
        expect(yield* ledgerOf(sql)).toBe(1);
      })
    )
  );

  it.effect(
    "on an executor without transactions a replayed rejection reports its stored reason",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const backend = backendWith(sql, rejectingHandlers, false);
          yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);

          const replay = yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);
          expect(replay.rejected).toEqual([rejected(1)]);
          expect(replay.hints).toEqual([]);
          expect(yield* countOf(sql, "effects")).toBe(0);
        })
      )
  );

  it.effect(
    "a rejection is kept while the client's push still carries it, and forgotten once a push starts past it",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const backend = backendWith(sql, rejectingHandlers);
          yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);

          // The client has not seen 1's outcome yet, so its next push starts at 1.
          const resent = yield* backend.applyMutations(context, [
            mutation(1, "todo/reject"),
            mutation(2),
          ]);
          expect(resent.rejected).toEqual([rejected(1)]);
          expect(resent.lastMutationIds).toEqual({ [CLIENT]: 2 });

          // The next push starts at 3: the client has seen the outcome of 1 and 2,
          // so 1's rejection is forgotten, and a copy of 1 is no longer reported.
          yield* backend.applyMutations(context, [mutation(3)]);
          const late = yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);
          expect(late.rejected).toBeUndefined();
          expect(late.lastMutationIds).toEqual({ [CLIENT]: 3 });
        })
      )
  );

  it.effect("several rejections of one client are remembered together, in push order", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const backend = backendWith(sql, rejectingHandlers);
        const pushed = [mutation(1, "todo/reject"), mutation(2), mutation(3, "todo/reject")];
        const first = yield* backend.applyMutations(context, pushed);
        expect(first.rejected).toEqual([rejected(1), rejected(3)]);

        const replay = yield* backend.applyMutations(context, pushed);
        expect(replay.rejected).toEqual([rejected(1), rejected(3)]);
        expect(replay.lastMutationIds).toEqual({ [CLIENT]: 3 });
        expect(yield* countOf(sql, "effects")).toBe(1);
      })
    )
  );

  it.effect(
    "a database without the rejections column fails clearly, naming the migration, and writes nothing",
    () =>
      withDatabase(
        (sql) =>
          Effect.gen(function* () {
            const backend = backendWith(sql, rejectingHandlers);
            const error = yield* backend.applyMutations(context, [mutation(1)]).pipe(Effect.flip);
            expect(error).toBeInstanceOf(BackendError);
            expect(error.message).toContain("ALTER TABLE sync_mutations ADD COLUMN rejections");
            expect(error.message).toContain("Ledger without the `rejections` column");
            expect(yield* countOf(sql, "effects")).toBe(0);
            expect(yield* ledgerOf(sql)).toBe(0);
          }),
        DDL_BEFORE_366
      )
  );

  it.effect("the documented ALTER TABLE brings an existing ledger up to date", () =>
    withDatabase(
      (sql) =>
        Effect.gen(function* () {
          yield* sql.unsafe(`ALTER TABLE sync_mutations ADD COLUMN rejections TEXT`).unprepared;
          const backend = backendWith(sql, rejectingHandlers);
          yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);

          const replay = yield* backend.applyMutations(context, [mutation(1, "todo/reject")]);
          expect(replay.rejected).toEqual([rejected(1)]);
        }),
      DDL_BEFORE_366
    )
  );
});
