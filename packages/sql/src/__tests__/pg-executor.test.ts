/**
 * `PgExecutor` on a real PostgreSQL server (#203): the round-trip budget of a
 * read and a push through the shipped executor, counted at the executor seam.
 * Its conformance run is the PostgreSQL block of `backend-contract.test.ts`,
 * which builds its backend over the same `PgExecutor.make`.
 *
 * Needs `DATABASE_URL`, a PostgreSQL URL for a database this test may reset;
 * without it the suite skips locally. The CI guard that refuses to skip lives in
 * `sql-backend-postgres.test.ts` and `backend-contract.test.ts`, which share the
 * variable.
 */
import { describe, expect, it } from "@effect/vitest";
import { PgClient } from "@effect/sql-pg";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { Mutator, Predicate } from "@thomasfosterau/legation-effect";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as PgExecutor from "../PgExecutor.js";
import * as Sql from "../Sql.js";
import * as SqlBackend from "../SqlBackend.js";

const databaseUrl = process.env.DATABASE_URL;
const context = { clientGroupId: "g" };

const DROP_TABLES = `DROP TABLE IF EXISTS pgx_projects, pgx_todos, pgx_sync_mutations`;

const DDL: ReadonlyArray<string> = [
  DROP_TABLES,
  `CREATE TABLE pgx_projects (id TEXT COLLATE "C" PRIMARY KEY, archived BOOLEAN NOT NULL)`,
  `CREATE TABLE pgx_todos (id TEXT COLLATE "C" PRIMARY KEY, project_id TEXT COLLATE "C" NOT NULL, done BOOLEAN NOT NULL)`,
  `CREATE TABLE pgx_sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
    PRIMARY KEY (client_group_id, client_id)
  )`,
  `INSERT INTO pgx_projects (id, archived) VALUES ('p1', false), ('p2', true)`,
  `INSERT INTO pgx_todos (id, project_id, done) VALUES ('t1', 'p1', false), ('t2', 'p1', true), ('t3', 'p2', false)`,
];

/** Statements and transactions an executor ran, counted at the seam: one entry per round trip. */
interface Counts {
  readonly statements: number;
  readonly transactions: number;
}

/** `executor`, with every `query`, `run` and `transaction` call counted into `counts`. */
const counting = (
  executor: SqlBackend.SqlExecutor,
  counts: Ref.Ref<Counts>
): SqlBackend.SqlExecutor => ({
  query: (fragment) =>
    Ref.update(counts, (c) => ({ ...c, statements: c.statements + 1 })).pipe(
      Effect.andThen(executor.query(fragment))
    ),
  run: (fragment) =>
    Ref.update(counts, (c) => ({ ...c, statements: c.statements + 1 })).pipe(
      Effect.andThen(executor.run(fragment))
    ),
  transaction: (effect) =>
    Ref.update(counts, (c) => ({ ...c, transactions: c.transactions + 1 })).pipe(
      Effect.andThen(executor.transaction(effect))
    ),
});

const setDone = Mutator.make("todo/done", Schema.Struct({ id: Schema.String }));

const backendOver = (executor: SqlBackend.SqlExecutor) =>
  SqlBackend.make({
    executor,
    dialect: Sql.postgres,
    tables: {
      projects: { table: "pgx_projects", kinds: { archived: "boolean" } },
      todos: { table: "pgx_todos", kinds: { project_id: "text", done: "boolean" } },
    },
    mutators: Mutator.registry([{ mutator: setDone, local: () => Effect.void }]).mutators,
    handlers: {
      [setDone.name]: (raw, tx) =>
        Effect.gen(function* () {
          const { id } = yield* Schema.decodeUnknownEffect(setDone.args)(raw).pipe(Effect.orDie);
          yield* tx.run({ text: `UPDATE pgx_todos SET done = true WHERE id = $1`, params: [id] });
          return [{ collection: "todos", ids: [id] }];
        }),
    },
    mutationsTable: "pgx_sync_mutations",
  });

/** Run `use` over a counted `PgExecutor` against a freshly reset schema. */
const withCounted = <A>(
  url: string,
  use: (
    backend: ReturnType<typeof backendOver>,
    counts: Ref.Ref<Counts>
  ) => Effect.Effect<A, unknown>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const built = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(url), maxConnections: 2 })
      );
      const sql = Context.get(built, SqlClient);
      yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement).unprepared, {
        concurrency: 1,
        discard: true,
      });
      const counts = yield* Ref.make<Counts>({ statements: 0, transactions: 0 });
      return yield* use(backendOver(counting(PgExecutor.make(sql), counts)), counts).pipe(
        Effect.ensuring(sql.unsafe(DROP_TABLES).unprepared.pipe(Effect.ignore))
      );
    })
  ).pipe(Effect.orDie);

const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("PgExecutor round trips (#203)", () => {
  // `it.live`: the PostgreSQL client and its pool run on real I/O (CONTRIBUTING, "Tests").
  it.live("evaluate costs one statement per subset, whatever its predicate", () =>
    withCounted(databaseUrl ?? "", (backend, counts) =>
      Effect.gen(function* () {
        const subsets = [
          Subset.make({ collection: "todos" }),
          Subset.make({ collection: "todos", where: Predicate.eq("done", false) }),
          Subset.make({
            collection: "todos",
            where: Predicate.and(Predicate.eq("project_id", "p1"), Predicate.eq("done", true)),
            orderBy: [{ field: "id", direction: "asc" }],
            limit: 1,
          }),
          Subset.make({ collection: "projects" }),
        ];
        const ids = yield* Effect.forEach(
          subsets,
          (subset) =>
            backend
              .evaluate(context, subset)
              .pipe(Effect.map((entries) => entries.map((entry) => entry.id))),
          { concurrency: 1 }
        );
        expect(ids.map((list) => list.toSorted())).toEqual([
          ["t1", "t2", "t3"],
          ["t1", "t3"],
          ["t2"],
          ["p1", "p2"],
        ]);
        expect(yield* Ref.get(counts)).toEqual({ statements: subsets.length, transactions: 0 });
      })
    )
  );

  it.live("an exists predicate costs one more statement per Exists node", () =>
    withCounted(databaseUrl ?? "", (backend, counts) =>
      Effect.gen(function* () {
        const live = Subset.make({
          collection: "todos",
          where: Predicate.exists({
            collection: "projects",
            localField: "project_id",
            foreignField: "id",
            where: Predicate.eq("archived", false),
          }),
        });
        const entries = yield* backend.evaluate(context, live);
        expect(entries.map((entry) => entry.id).toSorted()).toEqual(["t1", "t2"]);
        expect(yield* Ref.get(counts)).toEqual({ statements: 2, transactions: 0 });
      })
    )
  );

  it.live("a pushed batch runs in one transaction, however many mutations it holds", () =>
    withCounted(databaseUrl ?? "", (backend, counts) =>
      Effect.gen(function* () {
        const batch = ["t1", "t3"].map((id, index) => ({
          clientId: "c1",
          mutationId: index + 1,
          mutator: setDone.name,
          args: { id },
          createdAt: 0,
        }));
        yield* backend.applyMutations(context, batch);
        expect((yield* Ref.get(counts)).transactions).toBe(1);
        expect(yield* backend.lastMutationIds(context)).toEqual({ c1: 2 });
        const done = yield* backend.evaluate(
          context,
          Subset.make({ collection: "todos", where: Predicate.eq("done", true) })
        );
        expect(done.map((entry) => entry.id).toSorted()).toEqual(["t1", "t2", "t3"]);
      })
    )
  );
});
