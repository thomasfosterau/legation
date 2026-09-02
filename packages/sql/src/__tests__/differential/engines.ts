/**
 * The SQL legs of the differential filter harness (issue #153, ADR-0028):
 * one `corpus` table per engine, loaded from `FilterCorpus` rows, queried
 * with `Sql.compileSelect` on the engine's dialect, and ordered with an
 * explicit `ORDER BY` that states collation and NULL placement.
 *
 * - Postgres is the oracle. It runs in-process via PGlite (Postgres compiled
 *   to WASM), so the leg needs no service and runs unconditionally. Text
 *   columns are declared `COLLATE "C"`.
 * - SQLite runs via `@effect/sql-sqlite-node` (over `node:sqlite`) on
 *   `:memory:`. Booleans are bound as 0/1 (the driver refuses boolean binds)
 *   for rows and predicate literals alike; text uses the default `BINARY`
 *   collation.
 *
 * An absent JS field is inserted as SQL NULL on both (rule (b)).
 */
import { PGlite } from "@electric-sql/pglite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Predicate } from "@legation/effect";
import { FilterCorpus, type Subset } from "@legation/effect/internal";
import { Context, Effect, Layer, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Sql from "../../Sql.js";

/** A SQL subject: load rows, filter by predicate, order by terms. Ids only. */
export interface Engine {
  readonly name: string;
  readonly load: (rows: ReadonlyArray<FilterCorpus.CorpusRow>) => Effect.Effect<void>;
  /** Ids matching the predicate over the loaded rows, sorted ascending. */
  readonly where: (predicate: Predicate.Predicate) => Effect.Effect<ReadonlyArray<string>>;
  /** Ids of every loaded row in `ORDER BY <terms>, id` order. */
  readonly order: (orderBy: ReadonlyArray<Subset.OrderBy>) => Effect.Effect<ReadonlyArray<string>>;
}

const TABLE = "corpus";
const columns = FilterCorpus.corpusColumns;
const textColumns = new Set(
  columns
    .filter((column) => column.kind === "string" || column.kind === "instant")
    .map((c) => c.name)
);

type Encoder = (value: Predicate.Literal | undefined) => unknown;

const encodePostgres: Encoder = (value) => value ?? null;
const encodeSqlite: Encoder = (value) =>
  value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;

/** Column types per dialect, keyed by literal kind, so the DDL follows `corpusColumns`. */
const columnTypes: Record<"sqlite" | "postgres", Record<FilterCorpus.LiteralKind, string>> = {
  sqlite: {
    string: "TEXT",
    integer: "INTEGER",
    double: "REAL",
    boolean: "INTEGER",
    instant: "TEXT",
  },
  postgres: {
    string: `TEXT COLLATE "C"`,
    integer: "INTEGER",
    double: "DOUBLE PRECISION",
    boolean: "BOOLEAN",
    instant: `TEXT COLLATE "C"`,
  },
};

const createText = (
  dialect: Sql.Dialect,
  types: Record<FilterCorpus.LiteralKind, string>
): string => {
  const id = `${dialect.quote("id")} ${types.string} PRIMARY KEY`;
  const rest = columns.map((column) => `${dialect.quote(column.name)} ${types[column.kind]}`);
  return `CREATE TABLE ${dialect.quote(TABLE)} (${[id, ...rest].join(", ")})`;
};

const insertText = (dialect: Sql.Dialect): string => {
  const names = ["id", ...columns.map((column) => column.name)];
  const placeholders = names.map((_, index) => dialect.placeholder(index + 1));
  return `INSERT INTO ${dialect.quote(TABLE)} (${names.map(dialect.quote).join(", ")}) VALUES (${placeholders.join(", ")})`;
};

const rowParams = (row: FilterCorpus.CorpusRow, encode: Encoder): ReadonlyArray<unknown> => [
  row.id,
  ...columns.map((column) => encode(row.value[column.name])),
];

/**
 * `ORDER BY` with the collation and NULL placement ADR-0028 rule (c) fixes:
 * code-point order on text, NULLs last ascending and first descending
 * (Postgres's default, stated explicitly because SQLite's default is the
 * opposite), then id ascending as the tie-break `Subset.comparator` uses.
 */
const orderText = (
  orderBy: ReadonlyArray<Subset.OrderBy>,
  dialect: Sql.Dialect,
  collate: string
): string => {
  const term = (field: string, direction: Subset.Direction): string => {
    const column = dialect.quote(field);
    const collation = textColumns.has(field) || field === "id" ? ` COLLATE ${collate}` : "";
    const nulls = direction === "asc" ? "NULLS LAST" : "NULLS FIRST";
    return `${column}${collation} ${direction.toUpperCase()} ${nulls}`;
  };
  const terms = [...orderBy.map((t) => term(t.field, t.direction)), term("id", "asc")];
  return `SELECT ${dialect.quote("id")} FROM ${dialect.quote(TABLE)} ORDER BY ${terms.join(", ")}`;
};

interface Runner {
  readonly exec: (text: string) => Effect.Effect<void>;
  readonly query: (
    text: string,
    params: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>>;
}

const makeEngine = (
  name: string,
  dialect: Sql.Dialect,
  encode: Encoder,
  collate: string,
  runner: Runner
): Engine => ({
  name,
  load: (rows) =>
    Effect.gen(function* () {
      yield* runner.query(`DELETE FROM ${dialect.quote(TABLE)}`, []);
      const insert = insertText(dialect);
      for (const row of rows) yield* runner.query(insert, rowParams(row, encode));
    }),
  where: (predicate) => {
    const { text, params } = Sql.compileSelect({ table: TABLE, where: predicate, dialect });
    return runner
      .query(
        text,
        params.map((param) => encode(param as Predicate.Literal))
      )
      .pipe(Effect.map((rows) => rows.map((row) => row.id).toSorted()));
  },
  order: (orderBy) =>
    runner
      .query(orderText(orderBy, dialect, collate), [])
      .pipe(Effect.map((rows) => rows.map((row) => row.id))),
});

/** SQLite on `:memory:` through the Effect SQL client. */
export const makeSqlite: Effect.Effect<Engine, never, Scope.Scope> = Effect.gen(function* () {
  const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient);
  const runner: Runner = {
    exec: (text) => sql.unsafe(text).unprepared.pipe(Effect.asVoid, Effect.orDie),
    query: (text, params) => sql.unsafe<{ readonly id: string }>(text, params).pipe(Effect.orDie),
  };
  yield* runner.exec(createText(Sql.sqlite, columnTypes.sqlite));
  return makeEngine("sqlite", Sql.sqlite, encodeSqlite, "BINARY", runner);
});

/** Postgres in-process via PGlite, text columns `COLLATE "C"`. */
export const makePostgres: Effect.Effect<Engine, never, Scope.Scope> = Effect.gen(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const instance = new PGlite();
      await instance.waitReady;
      return instance;
    }),
    (instance) => Effect.promise(() => instance.close())
  );
  const runner: Runner = {
    exec: (text) => Effect.promise(() => db.exec(text)).pipe(Effect.asVoid),
    query: (text, params) =>
      Effect.promise(() => db.query<{ readonly id: string }>(text, [...params])).pipe(
        Effect.map((result) => result.rows)
      ),
  };
  yield* runner.exec(createText(Sql.postgres, columnTypes.postgres));
  return makeEngine("postgres", Sql.postgres, encodePostgres, `"C"`, runner);
});
