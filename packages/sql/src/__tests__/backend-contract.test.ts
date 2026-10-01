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
import { Context, Effect, Exit, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Authorization,
  Backend,
  BackendError,
  ClientStore,
  MutationRejected,
  Mutator,
  Transport,
} from "@legation/effect";
import {
  BackendContract,
  ClientEngine,
  Cvr,
  InvalidationBus,
  Paced,
  Subset,
  SyncServer,
} from "@legation/effect/internal";
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

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const todoSet = Mutator.make("todo/set", Schema.Unknown);
const todoMutators = Mutator.registry([
  {
    mutator: todoSet,
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const todoHandlers: Record<string, SqlBackend.SqlHandler> = {
  "todo/set": (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as Todo;
      yield* tx.run({
        text: `INSERT OR REPLACE INTO todos (id, title, done) VALUES (?, ?, ?)`,
        params: [args.id, args.title, args.done ? 1 : 0],
      });
      return [{ collection: "todos", ids: [args.id] }];
    }),
};

const allTodos = Subset.make({ collection: "todos" });

describe("paced compaction against SqlBackend (#249)", () => {
  it.effect("pushes a compacted journal through the SQL ledger and drains it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
        const sql = Context.get(context, SqlClient);
        yield* sql.unsafe(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT, done INTEGER)`)
          .unprepared;
        yield* sql.unsafe(
          `CREATE TABLE sync_mutations (
            client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
            PRIMARY KEY (client_group_id, client_id)
          )`
        ).unprepared;

        const backend = SqlBackend.make({
          executor: makeExecutor(sql),
          tables: { todos: { table: "todos" } },
          mutators: new Map([[todoSet.name, todoSet]]),
          handlers: todoHandlers,
        });
        const handler = yield* SyncServer.make.pipe(
          Effect.provideService(Backend.Backend, backend),
          Effect.provideService(
            Authorization.AuthPolicy,
            Authorization.policy({ todos: Authorization.allowAll })
          ),
          Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
          Effect.provideService(
            InvalidationBus.InvalidationBus,
            yield* InvalidationBus.makeInProcess
          )
        );
        const transport = yield* Transport.makeInMemory(handler, "group-sql");
        const store = yield* ClientStore.makeMemory;
        const engine = yield* ClientEngine.make({
          clientId: "client-sql",
          clientGroupId: "group-sql",
          mutators: todoMutators,
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, transport)
        );
        yield* engine.subscribe(allTodos);

        const paced = yield* Paced.coalesce(engine, "todo/set");
        for (let n = 1; n <= 3; n++)
          yield* paced.call("1", { id: "1", title: `e${n}`, done: false });
        yield* paced.call("2", { id: "2", title: "other", done: true });
        for (let n = 4; n <= 5; n++)
          yield* paced.call("1", { id: "1", title: `e${n}`, done: false });

        // Two survivors, contiguous from 1, in journal order (todo 2, then todo 1).
        const pending = yield* store.pendingMutations;
        expect(pending.map((m) => m.mutationId)).toEqual([1, 2]);

        const exit = yield* Effect.exit(engine.push);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* store.pendingMutations).toEqual([]);

        const rows = yield* sql.unsafe<{ id: string; title: string }>(
          `SELECT id, title FROM todos ORDER BY id`
        );
        expect(rows).toEqual([
          { id: "1", title: "e5" },
          { id: "2", title: "other" },
        ]);
        expect(yield* backend.lastMutationIds({ clientGroupId: "group-sql" })).toEqual({
          "client-sql": 2,
        });
      })
    )
  );
});
