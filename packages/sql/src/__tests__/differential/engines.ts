/**
 * The SQL legs of the differential filter harness (issue #153, ADR-0028):
 * one `corpus` table per engine, loaded from `FilterCorpus` rows, queried
 * with `Sql.compileSelect` on the engine's dialect with the corpus columns'
 * declared kinds, and ordered with an explicit `ORDER BY` that states
 * collation and NULL placement.
 *
 * - Postgres is the oracle. It runs in-process via PGlite (Postgres compiled
 *   to WASM), so the leg needs no service and runs unconditionally. The
 *   `text` column is declared `COLLATE "C"`; the `instant` column is a real
 *   `timestamptz`, which rejects a collation clause — so the corpus itself
 *   proves the compiler emits none for instants (#156) and that a
 *   `timestamptz` column compares like `Date#toISOString` text (rule (e)).
 * - SQLite runs via `@effect/sql-sqlite-node` (over `node:sqlite`) on
 *   `:memory:`. Booleans are stored as 0/1 (the driver refuses boolean
 *   binds); text uses the default `BINARY` collation.
 *
 * Bind parameters go to the driver exactly as the compiler produced them:
 * the typed binds (booleans as `1`/`0` on SQLite) and the collation clause
 * are the compiler's, and the harness proves them (#156). Only row inserts
 * encode values here. An absent JS field is inserted as SQL NULL on both
 * (rule (b)).
 *
 * Besides the id set a `WHERE` returns, each engine exposes the predicate's
 * three-valued verdict per row (`SELECT id, (<where>) AS verdict`), so the
 * harness can compare `Predicate.evaluate`'s `Option<boolean>` row by row
 * (ADR-0028 section 7) and not only the collapsed result.
 */
import { PGlite } from "@electric-sql/pglite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Predicate } from "@thomasfosterau/legation-effect";
import { FilterCorpus, type Subset } from "@thomasfosterau/legation-effect/internal";
import { Context, Effect, Layer, type Scope } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as Sql from "../../Sql.js";

/** A three-valued verdict: `T` true, `F` false, `U` unknown (SQL NULL). */
export type Verdict = "T" | "F" | "U";

/** A SQL subject: load rows, filter by predicate, order by terms, and judge per row. */
export interface Engine {
  readonly name: string;
  readonly load: (rows: ReadonlyArray<FilterCorpus.CorpusRow>) => Effect.Effect<void>;
  /** Ids matching the predicate over the loaded rows, sorted ascending. */
  readonly where: (predicate: Predicate.Predicate) => Effect.Effect<ReadonlyArray<string>>;
  /** Ids of every loaded row in `ORDER BY <terms>, id` order. */
  readonly order: (orderBy: ReadonlyArray<Subset.OrderBy>) => Effect.Effect<ReadonlyArray<string>>;
  /** The predicate's three-valued verdict for every loaded row, keyed by id. */
  readonly verdicts: (
    predicate: Predicate.Predicate
  ) => Effect.Effect<ReadonlyMap<string, Verdict>>;
}

const TABLE = "corpus";
const columns = FilterCorpus.corpusColumns;

/** The corpus columns' declared kinds, handed to the compiler (`kinds`). */
export const corpusKinds: Sql.Kinds = Object.fromEntries(
  columns.map((column) => [column.name, column.kind])
);

/** Columns whose `ORDER BY` term takes the collation clause: `text` only (an instant is `timestamptz` on Postgres). */
const collatedColumns = new Set(
  columns.filter((column) => column.kind === "text").map((column) => column.name)
);

type Encoder = (value: Predicate.Literal | undefined) => unknown;

const encodePostgres: Encoder = (value) => value ?? null;
const encodeSqlite: Encoder = (value) =>
  value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;

/**
 * Decode a `(<where>)` column: Postgres yields `true`/`false`/`null`, SQLite
 * `1`/`0`/`null`.
 */
const decodeVerdict = (raw: unknown): Verdict =>
  raw === null || raw === undefined ? "U" : raw === true || raw === 1 ? "T" : "F";

/** Column types per dialect, keyed by literal kind, so the DDL follows `corpusColumns`. */
const columnTypes: Record<"sqlite" | "postgres", Record<Predicate.LiteralKind, string>> = {
  sqlite: {
    text: "TEXT",
    integer: "INTEGER",
    double: "REAL",
    boolean: "INTEGER",
    instant: "TEXT",
  },
  postgres: {
    text: `TEXT COLLATE "C"`,
    integer: "INTEGER",
    double: "DOUBLE PRECISION",
    boolean: "BOOLEAN",
    instant: "TIMESTAMPTZ",
  },
};

const createText = (dialect: Sql.Dialect, types: Record<Predicate.LiteralKind, string>): string => {
  const id = `${dialect.quote("id")} ${types.text} PRIMARY KEY`;
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
const orderText = (orderBy: ReadonlyArray<Subset.OrderBy>, dialect: Sql.Dialect): string => {
  const term = (field: string, direction: Subset.Direction): string => {
    const column = dialect.quote(field);
    const collation =
      collatedColumns.has(field) || field === "id" ? ` COLLATE ${dialect.textCollation}` : "";
    const nulls = direction === "asc" ? "NULLS LAST" : "NULLS FIRST";
    return `${column}${collation} ${direction.toUpperCase()} ${nulls}`;
  };
  const terms = [...orderBy.map((t) => term(t.field, t.direction)), term("id", "asc")];
  return `SELECT ${dialect.quote("id")} FROM ${dialect.quote(TABLE)} ORDER BY ${terms.join(", ")}`;
};

interface IdRow {
  readonly id: string;
}

interface VerdictRow extends IdRow {
  readonly verdict: unknown;
}

interface Runner {
  readonly exec: (text: string) => Effect.Effect<void>;
  readonly query: <Row extends IdRow>(
    text: string,
    params: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<Row>>;
}

const makeEngine = (
  name: string,
  dialect: Sql.Dialect,
  encode: Encoder,
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
    const { text, params } = Sql.compileSelect({
      table: TABLE,
      where: predicate,
      dialect,
      kinds: corpusKinds,
    });
    return runner
      .query<IdRow>(text, params)
      .pipe(Effect.map((rows) => rows.map((row) => row.id).toSorted()));
  },
  order: (orderBy) =>
    runner
      .query<IdRow>(orderText(orderBy, dialect), [])
      .pipe(Effect.map((rows) => rows.map((row) => row.id))),
  verdicts: (predicate) => {
    const { text, params } = Sql.compileWhere(predicate, dialect, { kinds: corpusKinds });
    const select = `SELECT ${dialect.quote("id")}, (${text}) AS ${dialect.quote("verdict")} FROM ${dialect.quote(TABLE)}`;
    return runner
      .query<VerdictRow>(select, params)
      .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, decodeVerdict(row.verdict)]))));
  },
});

/** SQLite on `:memory:` through the Effect SQL client. */
export const makeSqlite: Effect.Effect<Engine, never, Scope.Scope> = Effect.gen(function* () {
  const context = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(context, SqlClient);
  const runner: Runner = {
    exec: (text) => sql.unsafe(text).unprepared.pipe(Effect.asVoid, Effect.orDie),
    query: <Row extends IdRow>(text: string, params: ReadonlyArray<unknown>) =>
      sql.unsafe<Row>(text, params).pipe(Effect.orDie),
  };
  yield* runner.exec(createText(Sql.sqlite, columnTypes.sqlite));
  return makeEngine("sqlite", Sql.sqlite, encodeSqlite, runner);
});

/** Postgres in-process via PGlite: text `COLLATE "C"`, instants `timestamptz`. */
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
    query: <Row extends IdRow>(text: string, params: ReadonlyArray<unknown>) =>
      Effect.promise(() => db.query<Row>(text, [...params])).pipe(
        Effect.map((result) => result.rows)
      ),
  };
  yield* runner.exec(createText(Sql.postgres, columnTypes.postgres));
  return makeEngine("postgres", Sql.postgres, encodePostgres, runner);
});
