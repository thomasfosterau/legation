/**
 * ADR-0009's law: every backend must pass `verifyBackendContract`. This runs
 * the executable contract suite against the app's real storage — `SqlBackend`
 * over the `node:sqlite` executor — proving in-order application, idempotent
 * skips, atomic id-bumps (transient aborts leave nothing), permanent
 * rejections that stage-and-rollback, subset evaluation, and row versions.
 */
import { describe, expect, it } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { BackendContract, BackendError, MutationRejected, Mutator } from "@legation/effect";
import { SqlBackend } from "@legation/sql";
import { makeExecutor } from "../server/db.js";

/** Contract collections live in their own two-column tables (id + n). */
const CONTRACT_DDL = `
CREATE TABLE __contract (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT);
CREATE TABLE __contract_eval (id TEXT PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT);
CREATE TABLE sync_mutations (
  client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
  PRIMARY KEY (client_group_id, client_id)
);
`;

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
      // Stage a write, then reject — the suite asserts it rolled back.
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n) VALUES (?, -1)`,
        params: [args.id],
      });
      return yield* Effect.fail(new MutationRejected({ reason: "contract/reject always rejects" }));
    }),
};

describe("commerce SQL backend", () => {
  it.effect("passes verifyBackendContract over the node:sqlite executor", () =>
    Effect.gen(function* () {
      const db = new DatabaseSync(":memory:");
      db.exec(CONTRACT_DDL);
      const backend = SqlBackend.make({
        executor: makeExecutor(db),
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
  );
});
