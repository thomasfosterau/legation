/**
 * Differential filter harness (issue #153, ADR-0028).
 *
 * Three evaluators of one predicate AST are compared over a seeded random
 * corpus: `Sql.compileWhere` on Postgres (the oracle, in-process via
 * PGlite), `Sql.compileWhere` on SQLite (`:memory:`), and the JS evaluator
 * `Predicate.evaluate`. Two comparisons per predicate: the returned id set
 * (the `WHERE` collapse), and the three-valued verdict per row —
 * `Some(true)` / `Some(false)` / `None` against the oracle's
 * `true` / `false` / `NULL`. Order is compared too: `Subset.comparator`
 * against `ORDER BY … COLLATE "C"` with explicit NULL placement. A
 * disagreement is shrunk to the minimal predicate/row pair and reported with
 * the seed.
 *
 * Every leg is green since #155 made the JS evaluator three-valued, absent ≡
 * NULL, text order code point, and booleans ordered `false < true`. The
 * restricted corpus (no NULL/absent, no astral text, no ordered booleans)
 * stays as the regression floor that was green before #155. Since #156 the
 * SQL legs compile with the corpus columns' declared kinds, so every text
 * comparison carries the explicit collation clause (`COLLATE "C"` /
 * `COLLATE BINARY`), instants carry none (the oracle's instant column is a
 * real `timestamptz`, which would reject one), and booleans reach SQLite as
 * `1`/`0` from the compiler, not from the harness.
 *
 * Seed: `LEGATION_CORPUS_SEED` overrides the default.
 */
import { Predicate } from "@legation/effect";
import { FilterCorpus, Subset } from "@legation/effect/internal";
import { Effect, Exit, Option, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Engine, makePostgres, makeSqlite, type Verdict } from "./differential/engines.js";

const seed = FilterCorpus.resolveSeed(process.env.LEGATION_CORPUS_SEED);

// Generation is synchronous and pure (a seeded `Random` service), so the
// corpora are built once at module load.

/** The full corpus: NULL, absent, astral text, ordered booleans — everything ADR-0028 covers. */
const full = Effect.runSync(FilterCorpus.generateCorpus({ seed }));
/**
 * The corpus every evaluator agreed on before #155: no NULL/absent, no
 * astral text, no ordered comparison on booleans. Same seed as `full` so the
 * seed a disagreement reports reproduces it; the options alone make it
 * distinct.
 */
const restricted = Effect.runSync(
  FilterCorpus.generateCorpus({
    seed,
    nulls: false,
    astral: false,
    booleanOrder: false,
  })
);
/** `restricted` re-id'd so it can share the SQL tables with `full`; the one place the prefix is chosen. */
const restrictedQ = prefixedCorpus("q", restricted);

type Ids = ReadonlyArray<string>;
type Rows = ReadonlyArray<FilterCorpus.CorpusRow>;
type Verdicts = ReadonlyMap<string, Verdict>;

/** A subject evaluates a predicate over a row set to a sorted id list. */
type Subject = (predicate: Predicate.Predicate, rows: Rows) => Effect.Effect<Ids>;
/** An orderer sorts a row set to an id list. */
type Orderer = (orderBy: ReadonlyArray<Subset.OrderBy>, rows: Rows) => Effect.Effect<Ids>;
/** A judge gives the three-valued verdict of a predicate for every row. */
type Judge = (predicate: Predicate.Predicate, rows: Rows) => Effect.Effect<Verdicts>;

const idsOf = (rows: Rows): Ids => rows.map((row) => row.id);
const sameIds = (left: Ids, right: Ids): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Render verdicts as `id=T` entries in id order, for comparison and reporting. */
const renderVerdicts = (verdicts: Verdicts): Ids =>
  [...verdicts.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, verdict]) => `${id}=${verdict}`);

// ─── JS subject ──────────────────────────────────────────────────────────────
//
// `Predicate.evaluate` is the three-valued evaluator (#155); `jsMatches` is
// its `WHERE` collapse, identical to `Predicate.test`. Rows are evaluated in
// their JS object form — absent keys stay absent.

const jsVerdict = (predicate: Predicate.Predicate, row: FilterCorpus.CorpusRow): Verdict =>
  Option.match(Predicate.evaluate(predicate, row.value), {
    onNone: () => "U" as const,
    onSome: (value) => (value ? ("T" as const) : ("F" as const)),
  });

const jsMatches = (predicate: Predicate.Predicate, row: FilterCorpus.CorpusRow): boolean =>
  jsVerdict(predicate, row) === "T";

const jsWhere: Subject = (predicate, rows) =>
  Effect.sync(() => idsOf(rows.filter((row) => jsMatches(predicate, row))).toSorted());

const jsOrder: Orderer = (orderBy, rows) =>
  Effect.sync(() => idsOf(rows.toSorted(Subset.comparator(orderBy))));

const jsJudge: Judge = (predicate, rows) =>
  Effect.sync(() => new Map(rows.map((row) => [row.id, jsVerdict(predicate, row)])));

// ─── SQL subjects ────────────────────────────────────────────────────────────
//
// Each engine holds one loaded row set. Predicates are row-local (never
// `Exists`), so the result over a subset of the loaded rows is the result
// over all of them restricted to the subset; the same holds for a total
// order and for per-row verdicts. That lets the minimiser drop rows without
// reloading the tables.

const restrictTo = (rows: Rows) => {
  const keep = new Set(idsOf(rows));
  return (ids: Ids): Ids => ids.filter((id) => keep.has(id));
};

const restrictVerdicts = (rows: Rows) => {
  const keep = new Set(idsOf(rows));
  return (verdicts: Verdicts): Verdicts =>
    new Map([...verdicts.entries()].filter(([id]) => keep.has(id)));
};

const sqlWhere =
  (engine: Engine): Subject =>
  (predicate, rows) =>
    engine.where(predicate).pipe(Effect.map(restrictTo(rows)));

const sqlOrder =
  (engine: Engine): Orderer =>
  (orderBy, rows) =>
    engine.order(orderBy).pipe(Effect.map(restrictTo(rows)));

const sqlJudge =
  (engine: Engine): Judge =>
  (predicate, rows) =>
    engine.verdicts(predicate).pipe(Effect.map(restrictVerdicts(rows)));

// ─── Drivers ─────────────────────────────────────────────────────────────────

interface Leg {
  readonly name: string;
  readonly where: Subject;
  readonly order: Orderer;
  readonly judge: Judge;
}

const fail = (disagreement: FilterCorpus.Disagreement): never => {
  throw new Error(FilterCorpus.formatDisagreement(disagreement));
};

/** Every corpus predicate: `subject` must return the oracle's id set. */
const checkWhere = (corpus: FilterCorpus.Corpus, subject: Leg, oracle: Leg) =>
  Effect.gen(function* () {
    const disagrees = (candidate: FilterCorpus.Case) =>
      Effect.gen(function* () {
        const expected = yield* oracle.where(candidate.predicate, candidate.rows);
        const actual = yield* subject.where(candidate.predicate, candidate.rows);
        return !sameIds(actual, expected);
      });
    for (const predicate of corpus.predicates) {
      const initial: FilterCorpus.Case = { predicate, rows: corpus.rows };
      if (!(yield* disagrees(initial))) continue;
      const minimal = yield* FilterCorpus.minimise(initial, disagrees);
      fail({
        seed: corpus.seed,
        subject: `${subject.name} disagrees with ${oracle.name}`,
        predicate: minimal.predicate,
        rows: minimal.rows,
        results: {
          [oracle.name]: yield* oracle.where(minimal.predicate, minimal.rows),
          [subject.name]: yield* subject.where(minimal.predicate, minimal.rows),
        },
      });
    }
  });

/**
 * Every corpus predicate, every row: `subject`'s three-valued verdict must
 * equal the oracle's — `Some(true)`/`Some(false)`/`None` against
 * `true`/`false`/`NULL` (ADR-0028 section 7, "per-row three-valued
 * equality"). Stricter than {@link checkWhere}: a `Some(false)` where the
 * oracle says unknown collapses to the same id set but is still a bug, since
 * `Not` flips one and not the other.
 */
const checkVerdicts = (corpus: FilterCorpus.Corpus, subject: Leg, oracle: Leg) =>
  Effect.gen(function* () {
    const disagrees = (candidate: FilterCorpus.Case) =>
      Effect.gen(function* () {
        const expected = yield* oracle.judge(candidate.predicate, candidate.rows);
        const actual = yield* subject.judge(candidate.predicate, candidate.rows);
        return !sameIds(renderVerdicts(actual), renderVerdicts(expected));
      });
    for (const predicate of corpus.predicates) {
      const initial: FilterCorpus.Case = { predicate, rows: corpus.rows };
      if (!(yield* disagrees(initial))) continue;
      const minimal = yield* FilterCorpus.minimise(initial, disagrees);
      fail({
        seed: corpus.seed,
        subject: `${subject.name} verdicts disagree with ${oracle.name}`,
        predicate: minimal.predicate,
        rows: minimal.rows,
        results: {
          [oracle.name]: renderVerdicts(yield* oracle.judge(minimal.predicate, minimal.rows)),
          [subject.name]: renderVerdicts(yield* subject.judge(minimal.predicate, minimal.rows)),
        },
      });
    }
  });

type OrderCase = { readonly terms: ReadonlyArray<Subset.OrderBy>; readonly rows: Rows };
type OrderDisagrees = (
  orderBy: ReadonlyArray<Subset.OrderBy>,
  rows: Rows
) => Effect.Effect<boolean>;

/** Drop one row at a time while the order still disagrees. */
const shrinkOrderRows = (
  disagrees: OrderDisagrees,
  terms: ReadonlyArray<Subset.OrderBy>,
  rows: Rows
) =>
  Effect.gen(function* () {
    let current = rows;
    let shrunk = true;
    while (shrunk) {
      shrunk = false;
      for (let i = 0; i < current.length && !shrunk; i++) {
        const fewer = current.filter((_, j) => j !== i);
        if (yield* disagrees(terms, fewer)) {
          current = fewer;
          shrunk = true;
        }
      }
    }
    return current;
  });

/** Shrink a disagreeing order case: fewer terms first, then fewer rows. */
const shrinkOrder = (
  disagrees: OrderDisagrees,
  orderBy: ReadonlyArray<Subset.OrderBy>,
  rows: Rows
): Effect.Effect<OrderCase> =>
  Effect.gen(function* () {
    let terms = orderBy;
    for (const term of orderBy) {
      if (terms.length > 1 && (yield* disagrees([term], rows))) terms = [term];
    }
    return { terms, rows: yield* shrinkOrderRows(disagrees, terms, rows) };
  });

/** Every corpus `orderBy`: `subject` must produce the oracle's id sequence. */
const checkOrder = (corpus: FilterCorpus.Corpus, subject: Leg, oracle: Leg) =>
  Effect.gen(function* () {
    const disagrees: OrderDisagrees = (orderBy, rows) =>
      Effect.gen(function* () {
        const expected = yield* oracle.order(orderBy, rows);
        const actual = yield* subject.order(orderBy, rows);
        return !sameIds(actual, expected);
      });
    for (const orderBy of corpus.orderBys) {
      if (!(yield* disagrees(orderBy, corpus.rows))) continue;
      const { terms, rows } = yield* shrinkOrder(disagrees, orderBy, corpus.rows);
      fail({
        seed: corpus.seed,
        subject: `${subject.name} order disagrees with ${oracle.name}`,
        orderBy: terms,
        rows,
        results: {
          [oracle.name]: yield* oracle.order(terms, rows),
          [subject.name]: yield* subject.order(terms, rows),
        },
      });
    }
  });

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("differential filter harness (ADR-0028)", () => {
  let scope: Scope.Closeable;
  let sqlite: Leg;
  let postgres: Leg;
  const js: Leg = { name: "js", where: jsWhere, order: jsOrder, judge: jsJudge };

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make());
    const engines = await Effect.runPromise(
      Scope.provide(scope)(
        Effect.gen(function* () {
          const sqliteEngine = yield* makeSqlite;
          const postgresEngine = yield* makePostgres;
          return { sqliteEngine, postgresEngine };
        })
      )
    );
    sqlite = {
      name: "sqlite",
      where: sqlWhere(engines.sqliteEngine),
      order: sqlOrder(engines.sqliteEngine),
      judge: sqlJudge(engines.sqliteEngine),
    };
    postgres = {
      name: "postgres",
      where: sqlWhere(engines.postgresEngine),
      order: sqlOrder(engines.postgresEngine),
      judge: sqlJudge(engines.postgresEngine),
    };
    // Both SQL legs hold the union of every row set used below; ids are
    // disjoint across corpora and focused cases, so restriction is exact.
    const loaded = [...full.rows, ...restrictedQ.rows, ...focusedRows];
    await Effect.runPromise(engines.sqliteEngine.load(loaded));
    await Effect.runPromise(engines.postgresEngine.load(loaded));
  }, 120_000);

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  });

  /** Run a check; it resolves when every case agrees and rejects with the minimal case otherwise. */
  const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);

  it("reports the seed and operator coverage", () => {
    console.info(`differential corpus seed ${seed}; coverage ${JSON.stringify(full.coverage)}`);
    // `true` is deliberately rare; everything else must recur.
    const thin = Object.entries(full.coverage).filter(
      ([name, count]) => count < (name === "true" ? 1 : 10)
    );
    expect(thin).toEqual([]);
  });

  describe("SQLite vs Postgres", () => {
    it(
      "agree on every generated predicate (full corpus)",
      () => expect(run(checkWhere(full, sqlite, postgres))).resolves.toBeUndefined(),
      60_000
    );
    it(
      "agree on every per-row verdict (full corpus)",
      () => expect(run(checkVerdicts(full, sqlite, postgres))).resolves.toBeUndefined(),
      60_000
    );
    it(
      "agree on every generated orderBy (full corpus)",
      () => expect(run(checkOrder(full, sqlite, postgres))).resolves.toBeUndefined(),
      60_000
    );
  });

  describe("JS Predicate.evaluate vs Postgres", () => {
    it(
      "agrees on the corpus without NULL/absent values, astral text or ordered booleans",
      () => expect(run(checkWhere(restrictedQ, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
    it(
      "agrees on the full corpus (NULL, absent, astral text, ordered booleans)",
      () => expect(run(checkWhere(full, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
    it(
      "agrees on every per-row three-valued verdict (full corpus)",
      () => expect(run(checkVerdicts(full, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
  });

  describe("JS Subset.comparator vs Postgres ORDER BY", () => {
    it(
      "agrees on the corpus without NULL/absent values or astral text",
      () => expect(run(checkOrder(restrictedQ, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
    it(
      "agrees on the full corpus (NULL, astral text)",
      () => expect(run(checkOrder(full, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
  });

  describe("focused minimal cases", () => {
    for (const focused of focusedWhere) {
      const rows = focusedRows.filter((row) => focused.ids.includes(row.id));
      const single = { ...full, predicates: [focused.predicate], rows };
      it(`SQLite agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkWhere(single, sqlite, postgres))).resolves.toBeUndefined());
      it(`JS agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkWhere(single, js, postgres))).resolves.toBeUndefined());
      it(`JS verdicts agree with Postgres: ${focused.name}`, () =>
        expect(run(checkVerdicts(single, js, postgres))).resolves.toBeUndefined());
    }
    for (const focused of focusedOrder) {
      const rows = focusedRows.filter((row) => focused.ids.includes(row.id));
      const single = { ...full, orderBys: [focused.orderBy], rows };
      it(`SQLite agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkOrder(single, sqlite, postgres))).resolves.toBeUndefined());
      it(`JS agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkOrder(single, js, postgres))).resolves.toBeUndefined());
    }
  });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Re-id a row set so it can share a table with another corpus. */
function prefixed(prefix: string, rows: Rows): Rows {
  return rows.map((row) => ({ id: `${prefix}${row.id}`, value: row.value }));
}

function prefixedCorpus(prefix: string, corpus: FilterCorpus.Corpus): FilterCorpus.Corpus {
  return { ...corpus, rows: prefixed(prefix, corpus.rows) };
}

/**
 * Hand-written rows for the focused cases: an explicit NULL, an absent
 * field, a plain value, the two strings whose order differs between UTF-16
 * code units and code points, the two booleans, three instants and three
 * integers (an int4 bound among them).
 */
const focusedRows: Rows = [
  { id: "f-null", value: { s: null } },
  { id: "f-absent", value: {} },
  { id: "f-x", value: { s: "x" } },
  { id: "f-a", value: { s: "a" } },
  { id: "f-ffff", value: { s: "￿" } },
  { id: "f-astral", value: { s: "😀" } },
  { id: "f-true", value: { b: true } },
  { id: "f-false", value: { b: false } },
  { id: "f-t-epoch", value: { t: "1970-01-01T00:00:00.000Z" } },
  { id: "f-t-2020", value: { t: "2020-02-29T12:34:56.789Z" } },
  { id: "f-t-2038", value: { t: "2038-01-19T03:14:07.000Z" } },
  { id: "f-i-1", value: { i: 1 } },
  { id: "f-i-7", value: { i: 7 } },
  { id: "f-i-max", value: { i: 2147483647 } },
];

const nullAndAbsent = ["f-null", "f-absent", "f-x"];
const instants = ["f-t-epoch", "f-t-2020", "f-t-2038", "f-absent"];
const integers = ["f-i-1", "f-i-7", "f-i-max", "f-absent"];

const focusedWhere: ReadonlyArray<{
  readonly name: string;
  readonly predicate: Predicate.Predicate;
  readonly ids: ReadonlyArray<string>;
}> = [
  {
    name: "ne over a NULL row and an absent row",
    predicate: Predicate.ne("s", "x"),
    ids: nullAndAbsent,
  },
  {
    name: "Not(eq) over a NULL row and an absent row",
    predicate: Predicate.not(Predicate.eq("s", "x")),
    ids: nullAndAbsent,
  },
  {
    name: "In over a NULL row and an absent row",
    predicate: Predicate.isIn("s", ["x", "y"]),
    ids: nullAndAbsent,
  },
  {
    name: "Not(In) over a NULL row and an absent row",
    predicate: Predicate.not(Predicate.isIn("s", ["x", "y"])),
    ids: nullAndAbsent,
  },
  {
    name: "NotIn over a NULL row and an absent row",
    predicate: Predicate.notIn("s", ["y"]),
    ids: nullAndAbsent,
  },
  {
    name: "eq(f, null) over an absent row",
    predicate: Predicate.eq("s", null),
    ids: ["f-absent", "f-x"],
  },
  {
    name: "IsNull over a NULL row and an absent row",
    predicate: Predicate.isNull("s"),
    ids: nullAndAbsent,
  },
  {
    // The deprecated wire form (ADR-0028 §5): unknown for every row on
    // every leg, unlike the constructor `eq(f, null)`, which is `IsNull`.
    name: "wire Compare eq with a null literal (unknown everywhere)",
    predicate: Predicate.compare("eq", "s", null),
    ids: nullAndAbsent,
  },
  {
    name: "wire Compare ne with a null literal (unknown everywhere)",
    predicate: Predicate.compare("ne", "s", null),
    ids: nullAndAbsent,
  },
  {
    name: "Not(wire Compare eq null) stays unknown",
    predicate: Predicate.not(Predicate.compare("eq", "s", null)),
    ids: nullAndAbsent,
  },
  {
    name: "IsNull negated over a NULL row and an absent row",
    predicate: Predicate.isNotNull("s"),
    ids: nullAndAbsent,
  },
  {
    name: "Kleene: unknown AND false is false, unknown OR true is true",
    predicate: Predicate.or(
      Predicate.and(Predicate.ne("s", "x"), Predicate.eq("s", "never")),
      Predicate.and(Predicate.ne("s", "x"), Predicate.isNull("s"))
    ),
    ids: nullAndAbsent,
  },
  {
    name: "gt on astral text (code point vs code unit)",
    predicate: Predicate.gt("s", "￿"),
    ids: ["f-a", "f-ffff", "f-astral"],
  },
  {
    name: "gt on booleans (false < true)",
    predicate: Predicate.gt("b", false),
    ids: ["f-true", "f-false", "f-absent"],
  },
  // #156: the collation clause and typed binds, node by node.
  {
    // `"s" COLLATE "C" < $1` against an astral literal: U+FFFF sorts below
    // U+1F600 by code point (both SQL legs) but above it by UTF-16 code unit.
    name: "text lt against an astral literal (collation clause)",
    predicate: Predicate.lt("s", "😀"),
    ids: ["f-a", "f-ffff", "f-astral"],
  },
  {
    name: "text In against an astral literal (collation clause on IN)",
    predicate: Predicate.isIn("s", ["😀", "a"]),
    ids: ["f-a", "f-ffff", "f-astral", "f-absent"],
  },
  {
    name: "text NotIn against an astral literal (collation clause on NOT IN)",
    predicate: Predicate.notIn("s", ["😀"]),
    ids: ["f-a", "f-ffff", "f-astral", "f-absent"],
  },
  {
    // No collation clause: the oracle's `t` is `timestamptz` and would
    // reject one; SQLite's `t` is text and compares by code point.
    name: "instant gt without a collation clause (timestamptz on Postgres)",
    predicate: Predicate.gt("t", "2000-01-01T00:00:00.000Z"),
    ids: instants,
  },
  {
    name: "instant In without a collation clause",
    predicate: Predicate.isIn("t", ["2020-02-29T12:34:56.789Z", "2038-01-19T03:14:07.000Z"]),
    ids: instants,
  },
  {
    name: "boolean eq bound as 1/0 on SQLite and as a boolean on Postgres",
    predicate: Predicate.eq("b", true),
    ids: ["f-true", "f-false", "f-absent"],
  },
  {
    name: "boolean In bound per dialect",
    predicate: Predicate.isIn("b", [false]),
    ids: ["f-true", "f-false", "f-absent"],
  },
  {
    name: "integer gte against an integral literal",
    predicate: Predicate.gte("i", 7),
    ids: integers,
  },
  {
    name: "integer In at the int4 bound",
    predicate: Predicate.isIn("i", [2147483647, 1]),
    ids: integers,
  },
];

const focusedOrder: ReadonlyArray<{
  readonly name: string;
  readonly orderBy: ReadonlyArray<Subset.OrderBy>;
  readonly ids: ReadonlyArray<string>;
}> = [
  {
    name: "astral text ordering",
    orderBy: [{ field: "s", direction: "asc" }],
    ids: ["f-a", "f-ffff", "f-astral"],
  },
  {
    name: "NULL ordering (NULLS LAST ascending)",
    orderBy: [{ field: "s", direction: "asc" }],
    ids: ["f-null", "f-absent", "f-a"],
  },
  {
    name: "NULL ordering (NULLS FIRST descending)",
    orderBy: [{ field: "s", direction: "desc" }],
    ids: ["f-null", "f-absent", "f-a"],
  },
  {
    name: "boolean ordering (false < true)",
    orderBy: [{ field: "b", direction: "asc" }],
    ids: ["f-true", "f-false"],
  },
  {
    name: "instant ordering (timestamptz on Postgres, text on SQLite)",
    orderBy: [{ field: "t", direction: "desc" }],
    ids: instants,
  },
];
