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

const DDL: ReadonlyArray<string> = [
  `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT)`,
  // A log of every write a handler made: one row per application, so a second
  // application of the same mutation is visible as a second row.
  `CREATE TABLE effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** Run `use` against a fresh in-memory SQLite database with the schema above. */
const withDatabase = <A>(use: (sql: SqlClient) => Effect.Effect<A, unknown>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
      const sql = Context.get(context, SqlClient);
      for (const statement of DDL) yield* sql.unsafe(statement).unprepared;
      return yield* use(sql);
    })
  );

/** `SqlExecutor` over the sqlite client; `transactional: false` mimics D1 (no transactions). */
const asBackendError = (message: string) => (cause: unknown) =>
  new BackendError({ message, cause });

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
