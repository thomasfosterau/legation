/**
 * `SqlBackend.evaluateMany` on a real SQLite engine (#505): a pull's subsets
 * in one `UNION ALL` statement, counted at the executor seam, and the same
 * entries as one `evaluate` per subset. The PostgreSQL bound is asserted in
 * `pg-executor.test.ts`; the equivalence over the generated corpus is
 * `BackendContract` rule 14, run in `backend-contract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { SqlClient } from "effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { BackendError, Mutator, Predicate } from "@thomasfosterau/legation-effect";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as SqlBackend from "../SqlBackend.js";

const context = { clientGroupId: "g" };

const DDL: ReadonlyArray<string> = [
  `CREATE TABLE projects (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, "it's" TEXT)`,
  `CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, done INTEGER NOT NULL, rank REAL, note TEXT)`,
  `INSERT INTO projects (id, archived, "it's") VALUES ('p1', 0, 'quoted'), ('p2', 1, NULL)`,
  `INSERT INTO todos (id, project_id, done, rank, note) VALUES
    ('t1', 'p1', 0, 1.5, 'a 𝄞'), ('t2', 'p1', 1, 2, NULL), ('t3', 'p2', 0, NULL, '{"x":1}')`,
];

/** A counted `SqlExecutor` over the Effect SQL sqlite client: one count per statement. */
const countedExecutor = (sql: SqlClient, statements: Ref.Ref<number>): SqlBackend.SqlExecutor => ({
  query: (fragment) =>
    Ref.update(statements, (n) => n + 1).pipe(
      Effect.andThen(sql.unsafe<SqlBackend.SqlRow>(fragment.text, fragment.params)),
      Effect.mapError((cause) => new BackendError({ message: fragment.text, cause }))
    ),
  run: (fragment) =>
    Ref.update(statements, (n) => n + 1).pipe(
      Effect.andThen(sql.unsafe(fragment.text, fragment.params)),
      Effect.asVoid,
      Effect.mapError((cause) => new BackendError({ message: fragment.text, cause }))
    ),
  transaction: (effect) => effect,
});

const withBackend = <A>(
  use: (
    backend: ReturnType<typeof SqlBackend.make>,
    statements: Ref.Ref<number>,
    sql: SqlClient
  ) => Effect.Effect<A, unknown>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const built = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
      const sql = Context.get(built, SqlClient);
      yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement).unprepared, {
        concurrency: 1,
        discard: true,
      });
      const statements = yield* Ref.make(0);
      const backend = SqlBackend.make({
        executor: countedExecutor(sql, statements),
        tables: {
          projects: { table: "projects", kinds: { archived: "boolean" } },
          todos: { table: "todos", kinds: { project_id: "text", done: "boolean" } },
        },
        mutators: Mutator.registry([]).mutators,
        handlers: {},
      });
      return yield* use(backend, statements, sql);
    })
  ).pipe(Effect.orDie);

const subsets = [
  Subset.make({ collection: "todos" }),
  Subset.make({ collection: "todos", where: Predicate.eq("done", false) }),
  Subset.make({
    collection: "todos",
    orderBy: [{ field: "rank", direction: "desc" }],
    limit: 2,
  }),
  Subset.make({ collection: "projects", where: Predicate.eq("archived", true) }),
  Subset.make({ collection: "unmapped" }),
  Subset.make({
    collection: "todos",
    where: Predicate.exists({
      collection: "projects",
      localField: "project_id",
      foreignField: "id",
      where: Predicate.eq("archived", false),
    }),
  }),
];

describe("SqlBackend.evaluateMany on SQLite (#505)", () => {
  it.effect("evaluates a pull's subsets in one statement, plus one per Exists node", () =>
    withBackend((backend, statements) =>
      Effect.gen(function* () {
        const evaluateMany = backend.evaluateMany;
        expect(evaluateMany).toBeDefined();
        if (evaluateMany === undefined) return;
        const first = yield* evaluateMany(context, subsets);
        // The first call looks up each read relation's columns once (two),
        // then one statement for the subsets and one for the Exists node.
        expect(yield* Ref.get(statements)).toBe(4);
        yield* Ref.set(statements, 0);
        const second = yield* evaluateMany(context, subsets);
        expect(yield* Ref.get(statements)).toBe(2);
        expect(second).toEqual(first);
        // NULL ranks highest under ADR-0028's order, so t3 leads the descending window.
        expect(first.map((entries) => entries.map((entry) => entry.id))).toEqual([
          ["t1", "t2", "t3"],
          ["t1", "t3"],
          ["t3", "t2"],
          ["p2"],
          [],
          ["t1", "t2"],
        ]);
      })
    )
  );

  it.effect("gives the entries, versions included, that one evaluate per subset gives", () =>
    withBackend((backend) =>
      Effect.gen(function* () {
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        const single = yield* Effect.forEach(
          subsets,
          (subset) => backend.evaluate(context, subset),
          {
            concurrency: 1,
          }
        );
        expect(yield* evaluateMany(context, subsets)).toEqual(single);
      })
    )
  );

  it.effect("makes no statement for no subsets, or only unmapped ones", () =>
    withBackend((backend, statements) =>
      Effect.gen(function* () {
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        expect(yield* evaluateMany(context, [])).toEqual([]);
        expect(yield* evaluateMany(context, [Subset.make({ collection: "unmapped" })])).toEqual([
          [],
        ]);
        expect(yield* Ref.get(statements)).toBe(0);
      })
    )
  );

  it.effect("carries each value as the driver reads it, past what JSON holds exactly", () =>
    withBackend((backend, statements, sql) =>
      Effect.gen(function* () {
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        // An integer past 2^53 and a double JSON at 15 digits would round:
        // SQLite's arms carry the columns themselves, so neither is touched.
        yield* sql.unsafe(`UPDATE todos SET rank = 9007199254740993 WHERE id = 't2'`).unprepared;
        yield* sql.unsafe(`UPDATE todos SET rank = 0.30000000000000004 WHERE id = 't1'`).unprepared;
        const wide = [
          Subset.make({ collection: "todos", orderBy: [{ field: "rank", direction: "desc" }] }),
          Subset.make({ collection: "todos", where: Predicate.gt("rank", 0.3) }),
        ];
        const single = yield* Effect.forEach(wide, (subset) => backend.evaluate(context, subset), {
          concurrency: 1,
        });
        yield* Ref.set(statements, 0);
        expect(yield* evaluateMany(context, wide)).toEqual(single);
        // The column lookup and the one batched statement: no fallback.
        expect(yield* Ref.get(statements)).toBe(2);
      })
    )
  );
});
