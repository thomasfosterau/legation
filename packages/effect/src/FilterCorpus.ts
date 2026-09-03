/**
 * FilterCorpus
 *
 * Seeded generators for the differential filter harness (issue #153,
 * ADR-0028). Three evaluators of one predicate AST exist — `Predicate.evaluate`
 * in JS, `Sql.compileWhere` on SQLite, and `Sql.compileWhere` on Postgres —
 * and Postgres is normative: every other evaluator must agree with it
 * exactly. This module produces the corpus they are compared over: random
 * rows over a fixed fixture schema (string, integer, double, boolean, ISO
 * instant) including NULL, absent fields, empty strings, boundary numerics,
 * and non-ASCII text up to astral characters; random depth-bounded
 * predicates covering every operator in the core; random `orderBy` terms;
 * and a minimiser that shrinks a disagreeing predicate/row pair to its
 * smallest reproducing form.
 *
 * The generators are Effects over Effect's `Random` service, and
 * `generateCorpus` runs them under `Random.withSeed(seed)` — Effect's own
 * seedable generator — so a seed reproduces a corpus exactly and a failure
 * reports the seed. This is the repo's shared corpus module; the property
 * tests elsewhere still carry their own hand-rolled mulberry32 copies (no
 * `fast-check` in the dependency set), and `Random.withSeed` is the idiom
 * to reach for instead of another copy.
 *
 * Rule (d) of ADR-0028 — no cross-type comparison — is enforced here by
 * construction: a leaf's literal always has its column's kind. Rule (e)
 * fixes the literal kinds: `integer` (int4 range), `double precision`,
 * boolean, and instants as `Date#toISOString` text compared as text.
 *
 * `Exists` is never generated; it is relational and has no single-row
 * meaning.
 */

import { Effect, Random } from "effect";
import * as Predicate from "./Predicate.js";
import type * as Subset from "./Subset.js";

// ─── Draws over the Random service ───────────────────────────────────────────

/** A uniform integer in `[0, max)`. */
const int = (max: number): Effect.Effect<number> =>
  Random.nextIntBetween(0, max, { halfOpen: true });
/** A uniform pick from a non-empty list (an empty one is a generator bug). */
const pick = <A>(xs: ReadonlyArray<A>): Effect.Effect<A> => Random.choice(xs).pipe(Effect.orDie);
/** `true` with probability `p`. */
const chance = (p: number): Effect.Effect<boolean> => Effect.map(Random.next, (roll) => roll < p);

/** The default corpus seed; `LEGATION_CORPUS_SEED` overrides it. */
export const DEFAULT_SEED = 20260902;

/**
 * Resolve the corpus seed from an optional environment override (the value
 * of `LEGATION_CORPUS_SEED`). Callers pass the variable in so this module
 * stays free of `process` (it ships in the engine core, which also runs in
 * browsers).
 */
export const resolveSeed = (override: string | undefined): number => {
  if (override === undefined || override.trim() === "") return DEFAULT_SEED;
  const seed = Number(override);
  if (!Number.isInteger(seed)) {
    throw new Error(`LEGATION_CORPUS_SEED must be an integer, got ${JSON.stringify(override)}`);
  }
  return seed;
};

// ─── Fixture schema ──────────────────────────────────────────────────────────

/** The literal kinds of ADR-0028 rule (e). */
export type LiteralKind = "string" | "integer" | "double" | "boolean" | "instant";

/** One column of the fixture schema: a row field with a declared literal kind. */
export interface Column {
  readonly name: string;
  readonly kind: LiteralKind;
}

/**
 * The harness's fixture table `corpus`: every non-id column is nullable.
 * Postgres declares `COLLATE "C"` on `id`, `s`, `t`; SQLite uses `BINARY`.
 */
export const corpusColumns: ReadonlyArray<Column> = [
  { name: "s", kind: "string" },
  { name: "i", kind: "integer" },
  { name: "d", kind: "double" },
  { name: "b", kind: "boolean" },
  { name: "t", kind: "instant" },
];

/** Generator knobs shared by rows and predicates. */
export interface CorpusOptions {
  /**
   * Generate NULL and absent (JS-only: the key is missing) field values.
   * Default `true`. `false` keeps every field present and non-null (the
   * regression floor every evaluator agreed on before ADR-0028's rules
   * (a)/(b) were implemented) and also drops the `isnull` operator, which is
   * a constant predicate over such rows: a corpus only covers `isnull` with
   * `nulls` on.
   */
  readonly nulls?: boolean;
  /**
   * Generate astral (non-BMP) text and text mixing BMP and astral
   * characters. Default `true`. This is where UTF-16 code-unit order (JS)
   * diverges from code-point order (Postgres `COLLATE "C"`, SQLite
   * `BINARY`) — ADR-0028 rule (c).
   */
  readonly astral?: boolean;
  /**
   * Apply the ordered operators (`gt gte lt lte`) to the boolean column too.
   * Default `true`. Postgres orders booleans `false < true` (ADR-0028
   * section 3), and so does `Predicate.compareLiterals`; `false` is the
   * regression floor from before that rule was implemented.
   */
  readonly booleanOrder?: boolean;
}

interface ResolvedOptions {
  readonly nulls: boolean;
  readonly astral: boolean;
  readonly booleanOrder: boolean;
}

const resolveOptions = (options: CorpusOptions | undefined): ResolvedOptions => ({
  nulls: options?.nulls ?? true,
  astral: options?.astral ?? true,
  booleanOrder: options?.booleanOrder ?? true,
});

// ─── Literal pools ───────────────────────────────────────────────────────────
//
// Rows draw from `rows`; predicate literals draw from `rows ∪ foreign`, so
// every operator is exercised both against values that occur and values
// that do not.

interface Pool {
  readonly rows: ReadonlyArray<Predicate.Literal>;
  readonly foreign: ReadonlyArray<Predicate.Literal>;
}

const ASCII_STRINGS: ReadonlyArray<string> = [
  "",
  "a",
  "b",
  "abc",
  "abd",
  "A",
  "Z",
  "z",
  " ",
  "a b",
  "0",
  "10",
  "9",
];

/** BMP non-ASCII: Latin-1, a private-use character, and the U+FFFF noncharacter. */
const BMP_STRINGS: ReadonlyArray<string> = ["é", "ß", "éa", "", "￿", "ｱ"];

/** Astral characters, alone and mixed with BMP text. */
const ASTRAL_STRINGS: ReadonlyArray<string> = [
  "😀",
  "𝔘",
  "\u{10FFFF}",
  "a😀",
  "😀a",
  "￿😀",
  "é😀",
  "😀😀",
];

const FOREIGN_STRINGS: ReadonlyArray<string> = ["nope", "zz", "è"];

const INTEGERS: ReadonlyArray<number> = [
  0, -0, 1, -1, 2, 3, 7, 10, 42, 100, -7, 2147483647, -2147483648, 2147483646,
];
const FOREIGN_INTEGERS: ReadonlyArray<number> = [5, -100, 12345];

const DOUBLES: ReadonlyArray<number> = [
  0,
  -0,
  0.5,
  -0.5,
  1e-7,
  1.5,
  // The boundary of exact integers in a double: 2^53 - 1, 2^53, and the next
  // representable double above it (2^53 + 1 is not one; it rounds to 2^53 in
  // JS and Postgres alike). These live in the double column only because
  // int4 cannot hold them.
  2 ** 53 - 1,
  2 ** 53,
  2 ** 53 + 2,
  1e300,
  -1e-300,
  3.25,
  100.125,
  -2.5,
];
const FOREIGN_DOUBLES: ReadonlyArray<number> = [2.75, 1e-6];

const INSTANTS: ReadonlyArray<string> = [
  new Date(0),
  new Date("1999-12-31T23:59:59.999Z"),
  new Date("2000-01-01T00:00:00.001Z"),
  new Date("2020-02-29T12:34:56.789Z"),
  new Date("2024-01-01T00:00:00.000Z"),
  new Date("2038-01-19T03:14:07.000Z"),
].map((date) => date.toISOString());
const FOREIGN_INSTANTS: ReadonlyArray<string> = [
  new Date("2001-09-09T01:46:40.000Z").toISOString(),
];

const poolFor = (kind: LiteralKind, options: ResolvedOptions): Pool => {
  switch (kind) {
    case "string":
      return {
        rows: [...ASCII_STRINGS, ...BMP_STRINGS, ...(options.astral ? ASTRAL_STRINGS : [])],
        foreign: FOREIGN_STRINGS,
      };
    case "integer":
      return { rows: INTEGERS, foreign: FOREIGN_INTEGERS };
    case "double":
      return { rows: DOUBLES, foreign: FOREIGN_DOUBLES };
    case "boolean":
      return { rows: [true, false], foreign: [] };
    case "instant":
      return { rows: INSTANTS, foreign: FOREIGN_INSTANTS };
  }
};

// ─── Rows ────────────────────────────────────────────────────────────────────

/**
 * A generated row in its JS object form: an absent field is a missing key,
 * distinct from an explicit `null`. The SQL legs insert both as SQL NULL
 * (ADR-0028 rule (b)).
 */
export interface CorpusRow {
  readonly id: string;
  readonly value: Readonly<Record<string, Predicate.Literal>>;
}

const NULL_RATE = 0.12;
const ABSENT_RATE = 0.08;

/** The shape of one row set: its columns, their pools, and the pinned prefix. */
interface RowPlan {
  readonly columns: ReadonlyArray<Column>;
  readonly pools: ReadonlyArray<ReadonlyArray<Predicate.Literal>>;
  readonly nulls: boolean;
  /** Rows 0..pinned-1 are the all-NULL and all-absent rows (with `nulls`). */
  readonly pinned: number;
  /** Rows pinned..pinned+sweep-1 walk every pool value into every column. */
  readonly sweep: number;
}

const planRows = (columns: ReadonlyArray<Column>, options: ResolvedOptions): RowPlan => {
  const pools = columns.map((column) => poolFor(column.kind, options).rows);
  return {
    columns,
    pools,
    nulls: options.nulls,
    pinned: options.nulls ? 2 : 0,
    sweep: Math.max(0, ...pools.map((pool) => pool.length)),
  };
};

/** A random field value: NULL, absent (`undefined`), or a pool value. */
const randomField = (
  pool: ReadonlyArray<Predicate.Literal>,
  nulls: boolean
): Effect.Effect<Predicate.Literal | undefined> =>
  Effect.gen(function* () {
    if (nulls) {
      const roll = yield* Random.next;
      if (roll < NULL_RATE) return null;
      if (roll < NULL_RATE + ABSENT_RATE) return undefined;
    }
    return yield* pick(pool);
  });

const generateRow = (plan: RowPlan, index: number): Effect.Effect<CorpusRow> =>
  Effect.gen(function* () {
    const value: Record<string, Predicate.Literal> = {};
    for (const [c, column] of plan.columns.entries()) {
      const pool = plan.pools[c]!;
      let field: Predicate.Literal | undefined;
      if (index < plan.pinned) field = index === 0 ? null : undefined;
      else if (index < plan.pinned + plan.sweep) field = pool[(index - plan.pinned) % pool.length];
      else field = yield* randomField(pool, plan.nulls);
      if (field !== undefined) value[column.name] = field;
    }
    return { id: `r${String(index).padStart(3, "0")}`, value };
  });

/**
 * The fewest rows {@link generateRows} accepts for `columns` under
 * `options`: the pinned NULL/absent rows plus the sweep that puts every pool
 * value into every column. Fewer would silently drop guaranteed edge values.
 */
export const minimumRows = (
  columns: ReadonlyArray<Column> = corpusColumns,
  options?: CorpusOptions
): number => {
  const plan = planRows(columns, resolveOptions(options));
  return plan.pinned + plan.sweep;
};

/**
 * Generate `count` rows over `columns`. Coverage of the edge values is
 * guaranteed, not left to chance: with `nulls` on, row 0 is all-NULL and row
 * 1 all-absent; then one row per pool position sweeps every pool value into
 * every column (int4 bounds, `-0`, `2^53±1`, the empty string, U+FFFF, the
 * astral characters, …); the remaining rows are random with NULL/absent
 * rolls. `count` below {@link minimumRows} is an error rather than a
 * truncated sweep. Ids are zero-padded ASCII (`r000`, `r001`, …) so their
 * order is the same in JS, SQLite `BINARY`, and Postgres `COLLATE "C"`,
 * keeping the id tie-break comparable across legs.
 */
export const generateRows = (
  count: number,
  columns: ReadonlyArray<Column> = corpusColumns,
  options?: CorpusOptions
): Effect.Effect<ReadonlyArray<CorpusRow>> => {
  const plan = planRows(columns, resolveOptions(options));
  const minimum = plan.pinned + plan.sweep;
  if (count < minimum) {
    throw new Error(
      `generateRows needs at least ${minimum} rows for these columns (the pinned rows plus the pool sweep), got ${count}`
    );
  }
  return Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => generateRow(plan, index)
  );
};

// ─── Operators ───────────────────────────────────────────────────────────────
//
// The operator core of ADR-0028: `eq ne lt lte gt gte in nin isnull` plus
// `and or not`. `nin` is the `NotIn` node and `isnull` the `IsNull` node,
// negated half the time so `IS NOT NULL` is exercised as its own node and
// not only as `Not(IsNull)`.

/** Every operator name the generator can emit; coverage is counted by these. */
export type OperatorName =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "isnull"
  | "and"
  | "or"
  | "not"
  | "true";

/** Per-operator emission counts for one generated corpus. */
export type Coverage = Record<OperatorName, number>;

/** A fresh all-zero coverage table. */
export const emptyCoverage = (): Coverage => ({
  eq: 0,
  ne: 0,
  gt: 0,
  gte: 0,
  lt: 0,
  lte: 0,
  in: 0,
  nin: 0,
  isnull: 0,
  and: 0,
  or: 0,
  not: 0,
  true: 0,
});

interface LeafOperator {
  readonly name: OperatorName;
  /** An ordered comparison: applied to a boolean column only with `booleanOrder`. */
  readonly ordered: boolean;
  /** Build the leaf from a literal draw and a list draw; each runs only if used. */
  readonly build: (
    field: string,
    literal: Effect.Effect<Predicate.Literal>,
    list: Effect.Effect<ReadonlyArray<Predicate.Literal>>
  ) => Effect.Effect<Predicate.Predicate>;
}

const comparison =
  (make: (field: string, value: Predicate.Literal) => Predicate.Predicate): LeafOperator["build"] =>
  (field, literal) =>
    Effect.map(literal, (value) => make(field, value));

/** The leaf operator table: one constructor per core operator. */
export const leafOperators: ReadonlyArray<LeafOperator> = [
  { name: "eq", ordered: false, build: comparison(Predicate.eq) },
  { name: "ne", ordered: false, build: comparison(Predicate.ne) },
  { name: "gt", ordered: true, build: comparison(Predicate.gt) },
  { name: "gte", ordered: true, build: comparison(Predicate.gte) },
  { name: "lt", ordered: true, build: comparison(Predicate.lt) },
  { name: "lte", ordered: true, build: comparison(Predicate.lte) },
  {
    name: "in",
    ordered: false,
    build: (field, _literal, list) => Effect.map(list, (values) => Predicate.isIn(field, values)),
  },
  {
    name: "nin",
    ordered: false,
    build: (field, _literal, list) => Effect.map(list, (values) => Predicate.notIn(field, values)),
  },
  {
    name: "isnull",
    ordered: false,
    build: (field) =>
      Effect.map(chance(0.5), (negated) =>
        negated ? Predicate.isNotNull(field) : Predicate.isNull(field)
      ),
  },
];

// ─── Predicates ──────────────────────────────────────────────────────────────

const EMPTY_IN_RATE = 0.1;
const LEAF_RATE = 0.55;
const TRUE_RATE = 0.03;
const FOREIGN_RATE = 0.3;

/** A literal of the pool's kind: usually one that occurs, sometimes one that does not. */
const literalFor = (pool: Pool): Effect.Effect<Predicate.Literal> =>
  Effect.gen(function* () {
    const foreign = pool.foreign.length > 0 && (yield* chance(FOREIGN_RATE));
    return yield* pick(foreign ? pool.foreign : pool.rows);
  });

/** An `In` list: occasionally empty, otherwise 1–4 literals. */
const listFor = (pool: Pool): Effect.Effect<ReadonlyArray<Predicate.Literal>> =>
  Effect.gen(function* () {
    if (yield* chance(EMPTY_IN_RATE)) return [];
    const length = 1 + (yield* int(4));
    return yield* literalFor(pool).pipe(Effect.replicateEffect(length));
  });

const generateLeaf = (
  columns: ReadonlyArray<Column>,
  options: ResolvedOptions,
  coverage: Coverage
): Effect.Effect<Predicate.Predicate> =>
  Effect.gen(function* () {
    if (yield* chance(TRUE_RATE)) {
      coverage.true++;
      return Predicate.always;
    }
    const column = yield* pick(columns);
    const pool = poolFor(column.kind, options);
    // Ordered operators reach the boolean column only with `booleanOrder`;
    // `isnull` is only worth emitting when NULL/absent rows exist.
    const candidates = leafOperators.filter(
      (op) =>
        (!op.ordered || column.kind !== "boolean" || options.booleanOrder) &&
        (op.name !== "isnull" || options.nulls)
    );
    const operator = yield* pick(candidates);
    coverage[operator.name]++;
    return yield* operator.build(column.name, literalFor(pool), listFor(pool));
  });

/**
 * Generate one depth-bounded predicate tree: leaves from the operator table
 * on a random column with a literal of that column's kind; `And`/`Or` with
 * 2–3 children and `Not` with one, down to `depth`. Emitted operators are
 * tallied into `coverage`.
 */
export const generatePredicate = (
  columns: ReadonlyArray<Column>,
  options: CorpusOptions | undefined,
  coverage: Coverage,
  depth = 2
): Effect.Effect<Predicate.Predicate> => {
  const resolved = resolveOptions(options);
  const go = (remaining: number): Effect.Effect<Predicate.Predicate> =>
    Effect.gen(function* () {
      if (remaining === 0 || (yield* chance(LEAF_RATE))) {
        return yield* generateLeaf(columns, resolved, coverage);
      }
      const shape = yield* int(3);
      if (shape === 2) {
        coverage.not++;
        return Predicate.not(yield* go(remaining - 1));
      }
      const width = 2 + (yield* int(2));
      const children = yield* go(remaining - 1).pipe(Effect.replicateEffect(width));
      if (shape === 0) {
        coverage.and++;
        return Predicate.and(...children);
      }
      coverage.or++;
      return Predicate.or(...children);
    });
  return go(depth);
};

// ─── Order terms ─────────────────────────────────────────────────────────────

/** Generate 1–2 `orderBy` terms over distinct columns with random directions. */
export const generateOrderBy = (
  columns: ReadonlyArray<Column> = corpusColumns
): Effect.Effect<ReadonlyArray<Subset.OrderBy>> =>
  Effect.gen(function* () {
    const count = Math.min(columns.length, 1 + (yield* int(2)));
    const shuffled = yield* Random.shuffle(columns);
    return yield* Effect.forEach(shuffled.slice(0, count), (column) =>
      Effect.map(
        Random.nextBoolean,
        (asc): Subset.OrderBy => ({ field: column.name, direction: asc ? "asc" : "desc" })
      )
    );
  });

// ─── Corpus ──────────────────────────────────────────────────────────────────

/** Options for {@link generateCorpus}. */
export interface GenerateOptions extends CorpusOptions {
  readonly seed: number;
  readonly columns?: ReadonlyArray<Column>;
  /** Rows in the fixture set (default 64: the pinned sweep plus random rows). */
  readonly rows?: number;
  /** Predicates to generate (default 200). */
  readonly predicates?: number;
  /** `orderBy` term lists to generate (default 60). */
  readonly orderBys?: number;
  /** Predicate tree depth bound (default 2). */
  readonly depth?: number;
}

/** A generated corpus: one row set, many predicates and order terms, and coverage. */
export interface Corpus {
  readonly seed: number;
  readonly columns: ReadonlyArray<Column>;
  readonly rows: ReadonlyArray<CorpusRow>;
  readonly predicates: ReadonlyArray<Predicate.Predicate>;
  readonly orderBys: ReadonlyArray<ReadonlyArray<Subset.OrderBy>>;
  readonly coverage: Coverage;
}

/**
 * Generate a whole corpus deterministically from a seed. The generators run
 * under `Random.withSeed(options.seed)`; the seeding is suspended so every
 * run of the returned effect starts the sequence afresh and yields the same
 * corpus.
 */
export const generateCorpus = (options: GenerateOptions): Effect.Effect<Corpus> =>
  Effect.suspend(() => {
    const columns = options.columns ?? corpusColumns;
    const coverage = emptyCoverage();
    return Effect.gen(function* () {
      const rows = yield* generateRows(options.rows ?? 64, columns, options);
      const predicates = yield* generatePredicate(
        columns,
        options,
        coverage,
        options.depth ?? 2
      ).pipe(Effect.replicateEffect(options.predicates ?? 200));
      const orderBys = yield* generateOrderBy(columns).pipe(
        Effect.replicateEffect(options.orderBys ?? 60)
      );
      return { seed: options.seed, columns, rows, predicates, orderBys, coverage };
    }).pipe(Random.withSeed(options.seed));
  });

// ─── Minimiser ───────────────────────────────────────────────────────────────

/** A predicate over a row set — the unit the harness compares and shrinks. */
export interface Case {
  readonly predicate: Predicate.Predicate;
  readonly rows: ReadonlyArray<CorpusRow>;
}

const replaceAt = <A>(xs: ReadonlyArray<A>, index: number, x: A): Array<A> =>
  xs.map((y, i) => (i === index ? x : y));
const without = <A>(xs: ReadonlyArray<A>, index: number): Array<A> =>
  xs.filter((_, i) => i !== index);

/**
 * One-step shrinks of a predicate, larger jumps first: replace a junction by
 * one child, drop one child, unwrap `Not`, drop one `In` value, then the
 * same recursively inside each child.
 */
export const shrinkPredicate = (
  predicate: Predicate.Predicate
): ReadonlyArray<Predicate.Predicate> => {
  switch (predicate._tag) {
    case "And":
    case "Or": {
      const rebuild = predicate._tag === "And" ? Predicate.and : Predicate.or;
      const children = predicate.predicates;
      const out: Array<Predicate.Predicate> = [];
      if (children.length > 1) {
        out.push(...children);
        out.push(...children.map((_, i) => rebuild(...without(children, i))));
      }
      children.forEach((child, i) => {
        for (const shrunk of shrinkPredicate(child)) {
          out.push(rebuild(...replaceAt(children, i, shrunk)));
        }
      });
      return out;
    }
    case "Not":
      return [predicate.predicate, ...shrinkPredicate(predicate.predicate).map(Predicate.not)];
    case "In":
    case "NotIn": {
      const rebuild = predicate._tag === "In" ? Predicate.isIn : Predicate.notIn;
      return predicate.values.length > 1
        ? predicate.values.map((_, i) => rebuild(predicate.field, without(predicate.values, i)))
        : [];
    }
    default:
      return [];
  }
};

const MAX_SHRINK_STEPS = 1000;

/**
 * Greedily shrink a disagreeing case while `disagrees` keeps holding:
 * predicate shrinks first, then row removals, restarting from the smallest
 * accepted candidate until no candidate still disagrees. `disagrees` runs the
 * subjects, so it is an Effect (the SQL legs are asynchronous).
 */
export const minimise = <E, R>(
  failing: Case,
  disagrees: (candidate: Case) => Effect.Effect<boolean, E, R>
): Effect.Effect<Case, E, R> =>
  Effect.gen(function* () {
    let current = failing;
    let steps = 0;
    while (steps < MAX_SHRINK_STEPS) {
      const candidates: Array<Case> = [
        ...shrinkPredicate(current.predicate).map((predicate) => ({
          predicate,
          rows: current.rows,
        })),
        ...current.rows.map((_, i) => ({
          predicate: current.predicate,
          rows: without(current.rows, i),
        })),
      ];
      let accepted: Case | undefined;
      for (const candidate of candidates) {
        steps++;
        if (yield* disagrees(candidate)) {
          accepted = candidate;
          break;
        }
      }
      if (accepted === undefined) break;
      current = accepted;
    }
    return current;
  });

// ─── Reporting ───────────────────────────────────────────────────────────────

/** A disagreement between subjects, ready to print. */
export interface Disagreement {
  readonly seed: number;
  readonly subject: string;
  readonly predicate?: Predicate.Predicate;
  readonly orderBy?: ReadonlyArray<Subset.OrderBy>;
  /** The (minimal) rows; any `(id, value)` row prints, not only corpus rows. */
  readonly rows: ReadonlyArray<Subset.Row>;
  /** Per-subject result (ids), keyed by subject name. */
  readonly results: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * How to reproduce at this seed. Defaults to the harness's environment
   * override; a caller with a fixed seed (`BackendContract`) says so instead.
   */
  readonly reproduce?: string;
}

/**
 * `JSON.stringify` that keeps `-0` visible (as the string `"-0"`): plain
 * JSON prints it as `0`, and a minimal case built on `-0` would not
 * reproduce from its own report.
 */
const print = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) => (Object.is(field, -0) ? "-0" : field));

/**
 * Render a disagreement: the seed, the (minimal) predicate or order terms,
 * the (minimal) rows — absent keys stay absent, `null` prints as `null`,
 * `-0` prints as `"-0"` — and every subject's ids.
 */
export const formatDisagreement = (disagreement: Disagreement): string => {
  const reproduce = disagreement.reproduce ?? "set LEGATION_CORPUS_SEED to reproduce";
  const lines = [`${disagreement.subject} (seed ${disagreement.seed}; ${reproduce})`];
  if (disagreement.predicate !== undefined) {
    lines.push(`predicate: ${print(disagreement.predicate)}`);
  }
  if (disagreement.orderBy !== undefined) {
    lines.push(`orderBy: ${print(disagreement.orderBy)}`);
  }
  lines.push("rows:");
  for (const row of disagreement.rows) {
    lines.push(`  ${row.id} ${print(row.value)}`);
  }
  for (const [name, ids] of Object.entries(disagreement.results)) {
    lines.push(`${name}: ${JSON.stringify(ids)}`);
  }
  return lines.join("\n");
};
