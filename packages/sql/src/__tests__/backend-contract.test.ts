/**
 * ADR-0009's law: every backend must pass `verifyBackendContract`. This runs
 * the executable contract suite against `SqlBackend` over a real SQLite
 * connection (`@effect/sql-sqlite-node`), not the in-memory query stub the
 * other `SqlBackend` tests use — several rules (the mutation-id ledger bump
 * atomic with effects, rollback on permanent rejection via SAVEPOINT) are
 * about transactional behaviour a stub cannot exhibit. Rule 6 carries the
 * differential harness's generated corpus (#153), so this run also proves the
 * SQLite compiler exact against `Subset.apply` (ADR-0028) on a real engine.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { BackendError, MutationRejected, Mutator } from "@legation/effect";
import { BackendContract } from "@legation/effect/internal";
import * as SqlBackend from "../SqlBackend.js";

/** `SqlExecutor` over the Effect SQL sqlite client (fragments → unsafe statements). */
const makeExecutor = (sql: SqlClient): SqlBackend.SqlExecutor => {
  const asBackendError = (message: string) => (cause: unknown) =>
    new BackendError({ message, cause });
  return {
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
  };
};

/** Contract collections live in their own two-column tables (id + n). */
const CONTRACT_DDL: ReadonlyArray<string> = [
  `CREATE TABLE __contract (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT)`,
  `CREATE TABLE __contract_eval (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

const TABLES: Record<string, string> = {
  __contract: "__contract",
  __contract_eval: "__contract_eval",
};

const tableFor = (collection: string): Effect.Effect<string, BackendError> => {
  const table = TABLES[collection];
  return table === undefined
    ? Effect.fail(new BackendError({ message: `unknown contract collection ${collection}` }))
    : Effect.succeed(table);
};

const contractMutators = new Map<string, Mutator.AnyMutator>([
  [BackendContract.putRow.name, BackendContract.putRow],
  [BackendContract.delRow.name, BackendContract.delRow],
  [BackendContract.failAlways.name, BackendContract.failAlways],
  [BackendContract.rejectAlways.name, BackendContract.rejectAlways],
]);

/**
 * The SQL-backend expression of the four contract mutators (mirrors
 * `BackendContract.memoryHandlers` for `MemoryBackend`): each handler runs its
 * own SQL directly against the transactional `tx`, and reports its own
 * `ChangeHint`s since (unlike `MemoryBackend`) there is no shared writer to
 * derive them from.
 */
const handlers: Record<string, SqlBackend.SqlHandler> = {
  [BackendContract.putRow.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as {
        collection: string;
        id: string;
        value: { n?: number; rank?: number; tag?: string };
      };
      const table = yield* tableFor(args.collection);
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n, rank, tag) VALUES (?, ?, ?, ?)`,
        params: [args.id, args.value?.n ?? null, args.value?.rank ?? null, args.value?.tag ?? null],
      });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.delRow.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      yield* tx.run({ text: `DELETE FROM ${table} WHERE id = ?`, params: [args.id] });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.failAlways.name]: () =>
    Effect.fail(new BackendError({ message: "contract/fail always fails" })),
  [BackendContract.rejectAlways.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      // Stage a write, then reject — the suite asserts it rolled back (rule 9),
      // which only means something because `tx` is a real SAVEPOINT-backed
      // transaction here, not the query stub's no-op `transaction`.
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n) VALUES (?, -1)`,
        params: [args.id],
      });
      return yield* new MutationRejected({ reason: "contract/reject always rejects" });
    }),
};

describe("SqlBackend", () => {
  it.effect("passes verifyBackendContract over a real SQLite executor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
        const sql = Context.get(context, SqlClient);
        for (const statement of CONTRACT_DDL) {
          yield* sql.unsafe(statement).unprepared;
        }
        const backend = SqlBackend.make({
          executor: makeExecutor(sql),
          tables: {
            __contract: { table: "__contract" },
            __contract_eval: { table: "__contract_eval" },
          },
          mutators: contractMutators,
          handlers,
        });
        yield* BackendContract.verifyBackendContract(backend);
        expect(true).toBe(true);
      })
    )
  );
});
