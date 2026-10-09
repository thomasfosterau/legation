/**
 * ADR-0009's law: every backend must pass `verifyBackendContract`. This runs
 * the executable contract suite against the app's real storage — `SqlBackend`
 * over the Effect SQL sqlite client — proving in-order application,
 * idempotent skips, atomic id-bumps (transient aborts leave nothing),
 * permanent rejections that stage-and-rollback, subset evaluation, and row
 * versions. Rule 6 carries the differential harness's generated corpus
 * (#153): random predicates over every operator in the core, NULL and absent
 * values, astral text, order terms and limits — so this one call also proves
 * the SQLite compiler exact against `Subset.apply` (ADR-0028) on the app's
 * own executor.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { BackendError, MutationRejected, Mutator } from "@thomasfosterau/legation-effect";
import { BackendContract } from "@thomasfosterau/legation-effect/internal";
import { SqlBackend } from "@thomasfosterau/legation-sql";
import { makeExecutor } from "../server/db.js";

/** Contract collections live in their own two-column tables (id + n). */
const CONTRACT_DDL: ReadonlyArray<string> = [
  `CREATE TABLE __contract (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT)`,
  `CREATE TABLE __contract_eval (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
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
  [BackendContract.writeThenFail.name, BackendContract.writeThenFail],
  [BackendContract.countUp.name, BackendContract.countUp],
]);

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
  [BackendContract.countUp.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string; gate: string };
      const table = yield* tableFor(args.collection);
      // Read, park between the read and the write (rule 11), then write the increment.
      const rows = yield* tx.query({ text: `SELECT n FROM ${table} WHERE id = ?`, params: [args.id] });
      yield* BackendContract.park(args.gate);
      yield* tx.run({
        text: `UPDATE ${table} SET n = ? WHERE id = ?`,
        params: [Number(rows[0]?.n ?? 0) + 1, args.id],
      });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.rejectAlways.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      // Stage a write, then reject — the suite asserts it rolled back.
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n) VALUES (?, -1)`,
        params: [args.id],
      });
      return yield* Effect.fail(new MutationRejected({ reason: "contract/reject always rejects" }));
    }),
  [BackendContract.writeThenFail.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      // Overwrite a live row, then fail transiently — the transaction rolls the write back.
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n) VALUES (?, 99)`,
        params: [args.id],
      });
      return yield* Effect.fail(
        new BackendError({ message: "contract/write-then-fail fails after writing" })
      );
    }),
};

describe("commerce SQL backend", () => {
  it.effect("passes verifyBackendContract over the Effect SQL sqlite client", () =>
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
