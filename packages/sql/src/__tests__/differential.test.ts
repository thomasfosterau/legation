/**
 * Differential filter harness (issue #153, ADR-0028).
 *
 * Three evaluators of one predicate AST are compared over a seeded random
 * corpus: `Sql.compileWhere` on Postgres (the oracle, in-process via
 * PGlite), `Sql.compileWhere` on SQLite (`:memory:`), and the JS evaluator
 * `Predicate.test`. Order is compared too: `Subset.comparator` against
 * `ORDER BY … COLLATE "C"` with explicit NULL placement. A disagreement is
 * shrunk to the minimal predicate/row pair and reported with the seed.
 *
 * What is red today is marked `it.fails` with the issue that turns it green:
 * the JS evaluator is two-valued where SQL is three-valued (`ne`, `Not`, `In`
 * over NULL/absent), `eq(f, null)` misses an absent field, and JS compares
 * text by UTF-16 code unit where Postgres `COLLATE "C"` and SQLite `BINARY`
 * compare by code point — so astral characters sort differently. SQLite and
 * Postgres agree on all of it (plain `it`), and so does JS on the corpus
 * without NULL/absent values and astral text.
 *
 * Seed: `LEGATION_CORPUS_SEED` overrides the default.
 */
import { Predicate } from "@legation/effect";
import { FilterCorpus, Subset } from "@legation/effect/internal";
import { Effect, Exit, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Engine, makePostgres, makeSqlite } from "./differential/engines.js";

const seed = FilterCorpus.resolveSeed(process.env.LEGATION_CORPUS_SEED);

/** The full corpus: NULL, absent, astral text — everything ADR-0028 covers. */
const full = FilterCorpus.generateCorpus({ seed });
/** The corpus every evaluator already agrees on: no NULL/absent, no astral text. */
const restricted = FilterCorpus.generateCorpus({ seed: seed + 1, nulls: false, astral: false });

type Ids = ReadonlyArray<string>;
type Rows = ReadonlyArray<FilterCorpus.CorpusRow>;

/** A subject evaluates a predicate over a row set to a sorted id list. */
type Subject = (predicate: Predicate.Predicate, rows: Rows) => Effect.Effect<Ids>;
/** An orderer sorts a row set to an id list. */
type Orderer = (orderBy: ReadonlyArray<Subset.OrderBy>, rows: Rows) => Effect.Effect<Ids>;

const idsOf = (rows: Rows): Ids => rows.map((row) => row.id);
const sameIds = (left: Ids, right: Ids): boolean => JSON.stringify(left) === JSON.stringify(right);

// ─── JS subject ──────────────────────────────────────────────────────────────
//
// The one function to switch when `Predicate.evaluate` lands (#155): compare
// the three-valued result per row instead of the two-valued `test`. Rows are
// evaluated in their JS object form — absent keys stay absent.

const jsMatches = (predicate: Predicate.Predicate, row: FilterCorpus.CorpusRow): boolean =>
  Predicate.test(predicate, row.value);

const jsWhere: Subject = (predicate, rows) =>
  Effect.sync(() => idsOf(rows.filter((row) => jsMatches(predicate, row))).toSorted());

const jsOrder: Orderer = (orderBy, rows) =>
  Effect.sync(() => idsOf(rows.toSorted(Subset.comparator(orderBy))));

// ─── SQL subjects ────────────────────────────────────────────────────────────
//
// Each engine holds one loaded row set. Predicates are row-local (never
// `Exists`), so the result over a subset of the loaded rows is the result
// over all of them restricted to the subset; the same holds for a total
// order. That lets the minimiser drop rows without reloading the tables.

const restrictTo = (rows: Rows) => {
  const keep = new Set(idsOf(rows));
  return (ids: Ids): Ids => ids.filter((id) => keep.has(id));
};

const sqlWhere =
  (engine: Engine): Subject =>
  (predicate, rows) =>
    engine.where(predicate).pipe(Effect.map(restrictTo(rows)));

const sqlOrder =
  (engine: Engine): Orderer =>
  (orderBy, rows) =>
    engine.order(orderBy).pipe(Effect.map(restrictTo(rows)));

// ─── Drivers ─────────────────────────────────────────────────────────────────

interface Leg {
  readonly name: string;
  readonly where: Subject;
  readonly order: Orderer;
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

/** Every corpus `orderBy`: `subject` must produce the oracle's id sequence. */
const checkOrder = (corpus: FilterCorpus.Corpus, subject: Leg, oracle: Leg) =>
  Effect.gen(function* () {
    const disagrees = (orderBy: ReadonlyArray<Subset.OrderBy>, rows: Rows) =>
      Effect.gen(function* () {
        const expected = yield* oracle.order(orderBy, rows);
        const actual = yield* subject.order(orderBy, rows);
        return !sameIds(actual, expected);
      });
    for (const orderBy of corpus.orderBys) {
      if (!(yield* disagrees(orderBy, corpus.rows))) continue;
      // Shrink: fewer terms first, then fewer rows, while it still disagrees.
      let terms = orderBy;
      let rows = corpus.rows;
      for (const term of orderBy) {
        if (terms.length > 1 && (yield* disagrees([term], rows))) terms = [term];
      }
      let shrunk = true;
      while (shrunk) {
        shrunk = false;
        for (let i = 0; i < rows.length; i++) {
          const fewer = rows.filter((_, j) => j !== i);
          if (yield* disagrees(terms, fewer)) {
            rows = fewer;
            shrunk = true;
            break;
          }
        }
      }
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
  const js: Leg = { name: "js", where: jsWhere, order: jsOrder };

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
    };
    postgres = {
      name: "postgres",
      where: sqlWhere(engines.postgresEngine),
      order: sqlOrder(engines.postgresEngine),
    };
    // Both SQL legs hold the union of every row set used below; ids are
    // disjoint across corpora and focused cases, so restriction is exact.
    const loaded = [...full.rows, ...prefixed("q", restricted.rows), ...focusedRows];
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
      "agree on every generated orderBy (full corpus)",
      () => expect(run(checkOrder(full, sqlite, postgres))).resolves.toBeUndefined(),
      60_000
    );
  });

  describe("JS Predicate.test vs Postgres", () => {
    it(
      "agrees on the corpus without NULL/absent values or astral text",
      () =>
        expect(
          run(checkWhere(prefixedCorpus("q", restricted), js, postgres))
        ).resolves.toBeUndefined(),
      60_000
    );
    // ADR-0028: red until #155 (JS evaluator); remove `fails` there.
    it.fails(
      "agrees on the full corpus (NULL, absent, astral text)",
      () => expect(run(checkWhere(full, js, postgres))).resolves.toBeUndefined(),
      60_000
    );
  });

  describe("JS Subset.comparator vs Postgres ORDER BY", () => {
    it(
      "agrees on the corpus without NULL/absent values or astral text",
      () =>
        expect(
          run(checkOrder(prefixedCorpus("q", restricted), js, postgres))
        ).resolves.toBeUndefined(),
      60_000
    );
    // ADR-0028: red until #155 (JS evaluator); remove `fails` there.
    it.fails(
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
      // ADR-0028: red until #155 (JS evaluator); remove `fails` there.
      it.fails(`JS agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkWhere(single, js, postgres))).resolves.toBeUndefined()
      );
    }
    for (const focused of focusedOrder) {
      const rows = focusedRows.filter((row) => focused.ids.includes(row.id));
      const single = { ...full, orderBys: [focused.orderBy], rows };
      it(`SQLite agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkOrder(single, sqlite, postgres))).resolves.toBeUndefined());
      // ADR-0028: red until #155 (JS evaluator); remove `fails` there.
      it.fails(`JS agrees with Postgres: ${focused.name}`, () =>
        expect(run(checkOrder(single, js, postgres))).resolves.toBeUndefined()
      );
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
 * field, a plain value, and the two strings whose order differs between
 * UTF-16 code units and code points.
 */
const focusedRows: Rows = [
  { id: "f-null", value: { s: null } },
  { id: "f-absent", value: {} },
  { id: "f-x", value: { s: "x" } },
  { id: "f-a", value: { s: "a" } },
  { id: "f-ffff", value: { s: "￿" } },
  { id: "f-astral", value: { s: "😀" } },
];

const nullAndAbsent = ["f-null", "f-absent", "f-x"];

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
    name: "Not(In) over a NULL row and an absent row",
    predicate: Predicate.not(Predicate.isIn("s", ["x", "y"])),
    ids: nullAndAbsent,
  },
  {
    name: "eq(f, null) over an absent row",
    predicate: Predicate.eq("s", null),
    ids: ["f-absent", "f-x"],
  },
  {
    name: "gt on astral text (code point vs code unit)",
    predicate: Predicate.gt("s", "￿"),
    ids: ["f-a", "f-ffff", "f-astral"],
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
];
