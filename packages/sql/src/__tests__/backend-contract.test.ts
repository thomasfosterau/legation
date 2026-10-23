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
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Authorization,
  Backend,
  BackendError,
  ClientStore,
  MutationRejected,
  Mutator,
  Transport,
} from "@thomasfosterau/legation-effect";
import {
  BackendContract,
  ClientEngine,
  Cvr,
  InvalidationBus,
  Paced,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import * as PgExecutor from "../PgExecutor.js";
import * as Sql from "../Sql.js";
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
  [BackendContract.writeThenFail.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      // Overwrite a live row, then fail transiently. The transaction rolls the
      // write back, so the suite sees the row unchanged (rule 10).
      yield* tx.run({
        text: `INSERT OR REPLACE INTO ${table} (id, n) VALUES (?, 99)`,
        params: [args.id],
      });
      return yield* Effect.fail(
        new BackendError({ message: "contract/write-then-fail fails after writing" })
      );
    }),
  [BackendContract.countUp.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string; gate: string };
      const table = yield* tableFor(args.collection);
      // Read the counter, park between the read and the write (rule 11), then
      // write the increment. The write is a plain UPDATE: the isolation under
      // test is the executor's, not the statement's.
      const rows = yield* tx.query({
        text: `SELECT n FROM ${table} WHERE id = ?`,
        params: [args.id],
      });
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

/** A SqlBackend over a fresh SQLite database with the contract tables; needs a scope. */
const makeContractBackend = (
  registeredHandlers: Record<string, SqlBackend.SqlHandler>,
  registeredMutators: Map<string, Mutator.AnyMutator>
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
    const sql = Context.get(context, SqlClient);
    for (const statement of CONTRACT_DDL) {
      yield* sql.unsafe(statement).unprepared;
    }
    return SqlBackend.make({
      executor: makeExecutor(sql),
      tables: {
        __contract: { table: "__contract" },
        __contract_eval: { table: "__contract_eval" },
      },
      mutators: registeredMutators,
      handlers: registeredHandlers,
    });
  });

describe("SqlBackend", () => {
  it.effect("passes verifyBackendContract over a real SQLite executor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeContractBackend(handlers, contractMutators);
        yield* BackendContract.verifyBackendContract(backend);
        expect(true).toBe(true);
      })
    )
  );

  it.effect("catches an unregistered write-then-fail mutator over a real SQLite executor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Unregistered in both the handler and the mutator maps, as a backend that
        // never heard of the probe would be. The unknown-mutator BackendError must
        // not pass the write-then-fail rule.
        const name = BackendContract.writeThenFail.name;
        const backend = yield* makeContractBackend(
          Object.fromEntries(Object.entries(handlers).filter(([key]) => key !== name)),
          new Map([...contractMutators].filter(([key]) => key !== name))
        );
        const failure = yield* Effect.flip(BackendContract.verifyBackendContract(backend));
        expect(failure.rule).toContain("discards");
        expect(failure.message).toContain("not registered");
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
            rejections TEXT,
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

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

/**
 * The same contract over `SqlBackend` on a real PostgreSQL server (guarantee 1,
 * #353): each `applyMutations` runs at SERIALIZABLE, so rule 11's peer and parked
 * calls run on two real transactions. Needs `DATABASE_URL` for a database this
 * test may reset. Its tables and ledger are its own, so it runs beside the
 * overlap suite (`sql-backend-postgres.test.ts`) on one database. Without the
 * variable the suite is skipped locally; in CI that file's guard fails instead.
 */
const databaseUrl = process.env.DATABASE_URL;

const PG_TABLES = `DROP TABLE IF EXISTS __contract, __contract_eval, contract_sync_mutations`;

const PG_DDL: ReadonlyArray<string> = [
  PG_TABLES,
  `CREATE TABLE __contract (id TEXT COLLATE "C" PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT COLLATE "C")`,
  `CREATE TABLE __contract_eval (id TEXT COLLATE "C" PRIMARY KEY, n INTEGER, rank INTEGER, tag TEXT COLLATE "C")`,
  `CREATE TABLE contract_sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** The shipped PostgreSQL executor (#203): real transactions, unprepared statements. */
const pgExecutor = PgExecutor.make;

/** The contract mutators, as PostgreSQL statements (`$n` placeholders, `ON CONFLICT` upserts). */
const pgHandlers: Record<string, SqlBackend.SqlHandler> = {
  [BackendContract.putRow.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as {
        collection: string;
        id: string;
        value: { n?: number; rank?: number; tag?: string };
      };
      const table = yield* tableFor(args.collection);
      yield* tx.run({
        text: `INSERT INTO ${table} (id, n, rank, tag) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n, rank = EXCLUDED.rank, tag = EXCLUDED.tag`,
        params: [args.id, args.value?.n ?? null, args.value?.rank ?? null, args.value?.tag ?? null],
      });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.delRow.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      yield* tx.run({ text: `DELETE FROM ${table} WHERE id = $1`, params: [args.id] });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.failAlways.name]: () =>
    Effect.fail(new BackendError({ message: "contract/fail always fails" })),
  [BackendContract.countUp.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string; gate: string };
      const table = yield* tableFor(args.collection);
      const rows = yield* tx.query({
        text: `SELECT n FROM ${table} WHERE id = $1`,
        params: [args.id],
      });
      yield* BackendContract.park(args.gate);
      yield* tx.run({
        text: `UPDATE ${table} SET n = $1 WHERE id = $2`,
        params: [Number(rows[0]?.n ?? 0) + 1, args.id],
      });
      return [{ collection: args.collection, ids: [args.id] }];
    }),
  [BackendContract.rejectAlways.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      yield* tx.run({
        text: `INSERT INTO ${table} (id, n) VALUES ($1, -1) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n`,
        params: [args.id],
      });
      return yield* new MutationRejected({ reason: "contract/reject always rejects" });
    }),
  [BackendContract.writeThenFail.name]: (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { collection: string; id: string };
      const table = yield* tableFor(args.collection);
      yield* tx.run({
        text: `INSERT INTO ${table} (id, n) VALUES ($1, 99) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n`,
        params: [args.id],
      });
      return yield* Effect.fail(
        new BackendError({ message: "contract/write-then-fail fails after writing" })
      );
    }),
};

/** Runs `use` on a pooled PostgreSQL client against a freshly created contract schema. */
const withPgContract = <A>(url: string, use: (sql: SqlClient) => Effect.Effect<A, unknown>) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Two concurrent transactions (the parked call and its peer) plus a spare.
      const built = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
      );
      const sql = Context.get(built, SqlClient);
      for (const statement of PG_DDL) yield* sql.unsafe(statement).unprepared;
      return yield* use(sql).pipe(
        Effect.ensuring(sql.unsafe(PG_TABLES).unprepared.pipe(Effect.ignore))
      );
    })
  ).pipe(Effect.orDie);

const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// Always runs, so a CI job without the service fails here instead of skipping the
// suite below in silence (the same guard as sql-backend-postgres.test.ts).
it("has DATABASE_URL in CI, so the PostgreSQL contract run cannot skip silently", () => {
  const ciWithoutDatabase = process.env.CI !== undefined && databaseUrl === undefined;
  expect(
    ciWithoutDatabase,
    "DATABASE_URL is not set in CI: the PostgreSQL contract run (#353) needs the PostgreSQL service container in .github/workflows/ci.yml"
  ).toBe(false);
});

/** A serialization refusal (SQLSTATE 40001): the transient `BackendError` the executor makes of a `SerializationError`. */
const isSerializationRefusal = (error: BackendError): boolean =>
  SqlError.isSqlError(error.cause) && error.cause.reason._tag === "SerializationError";

/** `executor` with each transaction it refuses as a serialization failure counted into `refusals`. */
const countingRefusals = (
  executor: SqlBackend.SqlExecutor,
  refusals: Ref.Ref<number>
): SqlBackend.SqlExecutor => ({
  ...executor,
  transaction: (effect) =>
    executor
      .transaction(effect)
      .pipe(
        Effect.tapError((error) =>
          isSerializationRefusal(error) ? Ref.update(refusals, (n) => n + 1) : Effect.void
        )
      ),
});

/**
 * Whether a contract statement is waiting on a lock: a `pg_stat_activity` check, not a sleep.
 * It matches only statements on the contract tables, since the overlap suite shares this database.
 */
const peerBlockedOnLock = (sql: SqlClient) =>
  sql
    .unsafe<{ waiting: number }>(
      `SELECT 1 AS waiting FROM pg_stat_activity WHERE datname = current_database() ` +
        `AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' ` +
        `AND strpos(query, '__contract') > 0 LIMIT 1`
    )
    .unprepared.pipe(
      Effect.map((rows) => Arr.isReadonlyArrayNonEmpty(rows)),
      Effect.orDie
    );

/**
 * PostgreSQL's `awaitPeer` (#416): the peer's statements are real I/O, so a turn
 * count cannot reach the overlap. Rule 11 holds the parked call until the peer has
 * finished, or is blocked on a lock (only the parked call can hold it). Both are
 * observed conditions, polled every few milliseconds, with no deadline of the
 * harness's own: a hang is the test's timeout. `onLockWait` runs only in the lock-wait
 * branch, just before `awaitPeer` returns there.
 */
const awaitPeerOn =
  (sql: SqlClient, onLockWait: Effect.Effect<void> = Effect.void): BackendContract.PeerSettle =>
  (peerSettled) =>
    Effect.gen(function* () {
      if (yield* peerSettled) return;
      if (yield* peerBlockedOnLock(sql)) {
        yield* onLockWait;
        return;
      }
      return yield* Effect.fail("pending" as const);
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("5 millis"),
        while: (state) => state === "pending",
      }),
      Effect.orDie
    );

/**
 * The `countUp` handler for the lock-wait test (#431). It takes the counter row's
 * lock before it parks (a no-op `SET n = n`), so the peer group blocks on that lock
 * instead of running to completion. It then reads, parks, and writes the increment
 * exactly as `pgHandlers`' `countUp` does, so rule 11 checks the same thing. It is
 * registered only in that test; the shared `countUp` above does not change.
 */
const lockingCountUp: SqlBackend.SqlHandler = (raw, tx) =>
  Effect.gen(function* () {
    const args = raw as { collection: string; id: string; gate: string };
    const table = yield* tableFor(args.collection);
    yield* tx.run({ text: `UPDATE ${table} SET n = n WHERE id = $1`, params: [args.id] });
    const rows = yield* tx.query({
      text: `SELECT n FROM ${table} WHERE id = $1`,
      params: [args.id],
    });
    yield* BackendContract.park(args.gate);
    yield* tx.run({
      text: `UPDATE ${table} SET n = $1 WHERE id = $2`,
      params: [Number(rows[0]?.n ?? 0) + 1, args.id],
    });
    return [{ collection: args.collection, ids: [args.id] }];
  });

/** The PostgreSQL contract backend over `executor` and `dialect`, with `handlerMap` (default `pgHandlers`). */
const backendOver = (
  executor: SqlBackend.SqlExecutor,
  dialect: Sql.Dialect,
  handlerMap: Record<string, SqlBackend.SqlHandler> = pgHandlers
) =>
  SqlBackend.make({
    executor,
    tables: {
      __contract: { table: "__contract", kinds: { rank: "integer", tag: "text" } },
      __contract_eval: { table: "__contract_eval", kinds: { rank: "integer", tag: "text" } },
    },
    mutators: contractMutators,
    handlers: handlerMap,
    dialect,
    mutationsTable: "contract_sync_mutations",
  });

/**
 * `awaitPeerOn`, setting `returnedOnLock` only when it returns through its lock-wait
 * branch (#431). A return by the peer settling leaves the flag unset.
 */
const awaitPeerRecording = (
  sql: SqlClient,
  returnedOnLock: Ref.Ref<boolean>
): BackendContract.PeerSettle => awaitPeerOn(sql, Ref.set(returnedOnLock, true));

describePostgres("SqlBackend on PostgreSQL: verifyBackendContract (#353)", () => {
  // `it.live`: the PostgreSQL client and its pool run on real I/O (CONTRIBUTING, "Tests").
  it.live(
    "passes verifyBackendContract at SERIALIZABLE, rule 11 included, and sees the overlap refused with 40001",
    () =>
      withPgContract(databaseUrl ?? "", (sql) =>
        Effect.gen(function* () {
          const refusals = yield* Ref.make(0);
          const backend = backendOver(countingRefusals(pgExecutor(sql), refusals), Sql.postgres);
          yield* BackendContract.verifyBackendContract(backend, { awaitPeer: awaitPeerOn(sql) });
          // Rule 11's parked call read before the peer committed, so its write is refused.
          expect(yield* Ref.get(refusals)).toBeGreaterThan(0);
        })
      ),
    60_000
  );

  // The READ COMMITTED mutant: the same backend without the SERIALIZABLE statement.
  // The peer commits while the parked call is held, and the call then writes its
  // stale count over the peer's increment. Rule 11 must fail on every run.
  it.live(
    "fails rule 11 for a READ COMMITTED executor on every run",
    () =>
      withPgContract(databaseUrl ?? "", (sql) =>
        Effect.gen(function* () {
          const backend = backendOver(pgExecutor(sql), {
            ...Sql.postgres,
            serializable: undefined,
          });
          const failure = yield* Effect.flip(
            BackendContract.verifyBackendContract(backend, { awaitPeer: awaitPeerOn(sql) })
          );
          expect(failure.rule).toContain("across client groups");
          expect(failure.message).toContain("got 1");
        })
      ),
    60_000
  );

  // The lock-wait branch of `awaitPeerOn` (#431). The parked call locks the row
  // before it parks, so the peer blocks on that lock and cannot finish until the
  // parked call is released. `awaitPeer` must return on that observation (it is
  // recorded), and rule 11 must then reach a verdict. Removing the lock branch
  // leaves `awaitPeer` waiting on a peer that waits on the parked call: a hang that
  // the 20 s timeout reports, well inside the 60 s test backstop.
  it.live(
    "returns awaitPeer on the peer's lock wait and still reaches a verdict (#431)",
    () =>
      withPgContract(databaseUrl ?? "", (sql) =>
        Effect.gen(function* () {
          const refusals = yield* Ref.make(0);
          const returnedOnLock = yield* Ref.make(false);
          const backend = backendOver(countingRefusals(pgExecutor(sql), refusals), Sql.postgres, {
            ...pgHandlers,
            [BackendContract.countUp.name]: lockingCountUp,
          });
          yield* BackendContract.verifyBackendContract(backend, {
            awaitPeer: awaitPeerRecording(sql, returnedOnLock),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "20 seconds",
              orElse: () =>
                Effect.die(new Error("awaitPeer did not return on the peer's lock wait")),
            })
          );
          expect(
            yield* Ref.get(returnedOnLock),
            "awaitPeer returned while the peer was unsettled, so the lock-wait branch ran"
          ).toBe(true);
          // The peer blocked on the parked row, then failed to serialise when it committed.
          expect(yield* Ref.get(refusals)).toBeGreaterThan(0);
        })
      ),
    60_000
  );
});
