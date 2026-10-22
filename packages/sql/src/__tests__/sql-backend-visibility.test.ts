/**
 * SqlBackend visibility before the bump (Backend guarantee 1, #381).
 *
 * A handler's writes and its ledger bump must stay invisible to a concurrent
 * read until its mutation commits, then both become visible together.
 *
 * The probe cannot read through the writer's own client. On `SqliteClient` the
 * transaction holds the client's one permit for its whole length, so a read on
 * that client would wait for the commit instead of observing the parked state.
 * It opens a second connection on the same WAL database file and reads through
 * it, as a real concurrent reader would. The probe returns what the reader saw;
 * the tests assert on it, and a mutant that leaks the write is detected by the
 * same probe.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql/SqlClient";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { BackendError, Mutator } from "@thomasfosterau/legation-effect";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as SqlBackend from "../SqlBackend.js";

const context = { clientGroupId: "visibility-group" };
const clientId = "visibility-client";

/** A pushed mutation that parks after its write (the handler below). */
const park = Mutator.make(
  "visibility/park",
  Schema.Struct({ id: Schema.String, n: Schema.Number })
);

const DDL: ReadonlyArray<string> = [
  `CREATE TABLE rows (id TEXT PRIMARY KEY, n INTEGER)`,
  `CREATE TABLE sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
    PRIMARY KEY (client_group_id, client_id)
  )`,
];

/** `SqlExecutor` over an Effect SQL client: fragments become unsafe statements. */
const asBackendError = (message: string) => (cause: unknown) =>
  new BackendError({ message, cause });

const makeExecutor = (sql: SqlClient): SqlBackend.SqlExecutor => {
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

/**
 * The same statements with no transaction around them: every write commits as
 * it runs. This is the deliberately broken backend the probe must catch.
 */
const withoutTransactions = (sql: SqlClient): SqlBackend.SqlExecutor => ({
  ...makeExecutor(sql),
  transaction: (effect) => effect,
});

/** Parks after its write, announcing `parked` and waiting for `release`. */
const parkingHandler =
  (parked: Deferred.Deferred<void>, release: Deferred.Deferred<void>): SqlBackend.SqlHandler =>
  (raw, tx) =>
    Effect.gen(function* () {
      const args = raw as { id: string; n: number };
      yield* tx.run({ text: `INSERT INTO rows (id, n) VALUES (?, ?)`, params: [args.id, args.n] });
      yield* Deferred.succeed(parked, undefined);
      yield* Deferred.await(release);
      return [{ collection: "rows", ids: [args.id] }];
    });

/** What a concurrent reader sees: the rows, the evaluated subset and the ledger. */
interface View {
  readonly rows: ReadonlyArray<unknown>;
  readonly entries: ReadonlyArray<unknown>;
  readonly ledger: Readonly<Record<string, number>>;
}

const readView = (reader: ReturnType<typeof SqlBackend.make>) =>
  Effect.gen(function* () {
    const rows = (yield* reader.getRows(context, "rows", ["a"])).map((row) => row.value);
    const entries = yield* reader.evaluate(context, Subset.make({ collection: "rows" }));
    const ledger = yield* reader.lastMutationIds(context);
    return { rows, entries, ledger } satisfies View;
  });

interface Probe {
  /** What the reader saw while the handler was parked after its write. */
  readonly parked: View;
  /** What the reader saw once the mutation committed. */
  readonly committed: View;
  /** The watermark the push itself reported. */
  readonly reported: Readonly<Record<string, number>>;
}

/**
 * Runs one push whose handler parks after its write, reads through a second
 * connection while it is parked, then releases it and reads again.
 */
const probe = (executorOf: (sql: SqlClient) => SqlBackend.SqlExecutor) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Removed (recursively) when the probe's scope closes, after both clients.
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "legation-sql-visibility-",
      });
      const filename = (yield* Path.Path).join(dir, "visibility.db");
      const writerSql = Context.get(
        yield* Layer.build(SqliteClient.layer({ filename })),
        SqlClient
      );
      const readerSql = Context.get(
        yield* Layer.build(SqliteClient.layer({ filename })),
        SqlClient
      );
      for (const statement of DDL) yield* writerSql.unsafe(statement).unprepared;

      const parkedSignal = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = SqlBackend.make({
        executor: executorOf(writerSql),
        tables: { rows: { table: "rows" } },
        mutators: new Map([[park.name, park]]),
        handlers: { [park.name]: parkingHandler(parkedSignal, release) },
      });
      const reader = SqlBackend.make({
        executor: makeExecutor(readerSql),
        tables: { rows: { table: "rows" } },
        mutators: new Map(),
        handlers: {},
      });

      const push = yield* Effect.forkChild(
        writer.applyMutations(context, [
          {
            clientId,
            mutationId: 1,
            mutator: park.name,
            args: { id: "a", n: 1 },
            createdAt: 0,
          },
        ])
      );
      // Parked after the write, or the mutation finished without parking. The
      // release runs on every path so a failing probe cannot leave the push parked.
      yield* Effect.raceFirst(
        Deferred.await(parkedSignal),
        Fiber.await(push).pipe(
          Effect.andThen(Effect.die(new Error("the mutation finished without parking")))
        )
      );
      const parked = yield* readView(reader).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.ignore))
      );

      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(push);
      const committed = yield* readView(reader);
      return { parked, committed, reported: result.lastMutationIds } satisfies Probe;
    })
  ).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

/** The guarantee: a parked mutation's write and bump are invisible to a concurrent reader. */
const expectInvisibleWhileParked = (parked: View) => {
  expect(parked.rows).toEqual([]);
  expect(parked.entries).toEqual([]);
  expect(parked.ledger).toEqual({});
};

describe("SqlBackend visibility before the bump (guarantee 1, #381)", () => {
  it.effect("a concurrent read sees neither a parked handler's write nor its bump", () =>
    Effect.gen(function* () {
      const observed = yield* probe(makeExecutor);
      expectInvisibleWhileParked(observed.parked);
    })
  );

  it.effect("the write and the bump are both visible once the mutation commits", () =>
    Effect.gen(function* () {
      const observed = yield* probe(makeExecutor);
      expect(observed.reported).toEqual({ [clientId]: 1 });
      expect(observed.committed.rows).toEqual([expect.objectContaining({ n: 1 })]);
      expect(observed.committed.entries).toEqual([expect.objectContaining({ id: "a" })]);
      expect(observed.committed.ledger).toEqual({ [clientId]: 1 });
    })
  );

  // Mutation: no transaction around the push. The claim (the bump) then commits
  // before the handler runs. The handler's own SAVEPOINT still holds its write
  // until RELEASE, so the leak is the bump alone: the probe must see the ledger
  // at 1 while the row and the subset are still empty.
  it.effect("leaks the bump, and only the bump, when the push has no transaction (mutation)", () =>
    Effect.gen(function* () {
      const observed = yield* probe(withoutTransactions);
      expect(observed.parked.rows).toEqual([]);
      expect(observed.parked.entries).toEqual([]);
      expect(observed.parked.ledger).toEqual({ [clientId]: 1 });
    })
  );
});
