/**
 * FilterCorpus
 *
 * Seeded generators for the differential filter harness (issue #153,
 * ADR-0028). Three evaluators of one predicate AST exist — `Predicate.test`
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
 * No `fast-check` in this repo's dependency set (see
 * `collection-index-property.test.ts`), so the PRNG is a hand-rolled
 * mulberry32 with a fixed default seed; a failure reports the seed so it
 * reproduces exactly.
 *
 * Rule (d) of ADR-0028 — no cross-type comparison — is enforced here by
 * construction: a leaf's literal always has its column's kind. Rule (e)
 * fixes the literal kinds: `integer` (int4 range), `double precision`,
 * boolean, and instants as `Date#toISOString` text compared as text.
 *
 * `Exists` is never generated; it is relational and has no single-row
 * meaning.
 */

import { Effect } from "effect";
import * as Predicate from "./Predicate.js";
import type * as Subset from "./Subset.js";

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

/** A seeded uniform generator over `[0, 1)`. */
export type Rng = () => number;

/** mulberry32: a small, fast, deterministic PRNG — the repo's convention. */
export const mulberry32 = (seed: number): Rng => {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A uniform integer in `[0, max)`. */
export const int = (rng: Rng, max: number): number => Math.floor(rng() * max);
/** A uniform pick from a non-empty list. */
export const pick = <A>(rng: Rng, xs: ReadonlyArray<A>): A => xs[int(rng, xs.length)]!;
/** `true` with probability `p`. */
export const chance = (rng: Rng, p: number): boolean => rng() < p;

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
   * Default `true`. `false` keeps every field present and non-null — the
   * setting `BackendContract` uses until #155/#156 make the JS evaluator
   * and SQL compilers NULL-exact (ADR-0028 rule (a)/(b)).
   */
  readonly nulls?: boolean;
  /**
   * Generate astral (non-BMP) text and text mixing BMP and astral
   * characters. Default `true`. This is where UTF-16 code-unit order (JS)
   * diverges from code-point order (Postgres `COLLATE "C"`, SQLite
   * `BINARY`) — ADR-0028 rule (c).
   */
  readonly astral?: boolean;
}

interface ResolvedOptions {
  readonly nulls: boolean;
  readonly astral: boolean;
}

const resolveOptions = (options: CorpusOptions | undefined): ResolvedOptions => ({
  nulls: options?.nulls ?? true,
  astral: options?.astral ?? true,
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
const BMP_STRINGS: ReadonlyArray<string> = ["é", "ß", "éa", "", "￿", "ｱ"];

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
  2 ** 53 - 1,
  2 ** 53,
  // Rounds to 2^53 in both JS and Postgres (double precision); it lives in
  // the double column only because int4 cannot hold it.
  2 ** 53 + 1,
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

/**
 * Generate `count` rows over `columns`. Coverage of the edge values is
 * guaranteed, not left to chance: with `nulls` on, row 0 is all-NULL and row
 * 1 all-absent; then one row per pool position sweeps every pool value into
 * every column (int4 bounds, `-0`, `2^53±1`, the empty string, U+FFFF, the
 * astral characters, …); the remaining rows are random with NULL/absent
 * rolls. Ids are zero-padded ASCII (`r000`, `r001`, …) so their order is the
 * same in JS, SQLite `BINARY`, and Postgres `COLLATE "C"`, keeping the id
 * tie-break comparable across legs.
 */
export const generateRows = (
  rng: Rng,
  count: number,
  columns: ReadonlyArray<Column> = corpusColumns,
  options?: CorpusOptions
): ReadonlyArray<CorpusRow> => {
  const resolved = resolveOptions(options);
  const pools = columns.map((column) => poolFor(column.kind, resolved).rows);
  const pinned = resolved.nulls ? 2 : 0;
  const sweep = Math.max(0, ...pools.map((pool) => pool.length));
  return Array.from({ length: count }, (_, index) => {
    const value: Record<string, Predicate.Literal> = {};
    columns.forEach((column, c) => {
      const pool = pools[c]!;
      if (index < pinned) {
        if (index === 0) value[column.name] = null;
        return;
      }
      if (index < pinned + sweep) {
        value[column.name] = pool[(index - pinned) % pool.length]!;
        return;
      }
      if (resolved.nulls) {
        const roll = rng();
        if (roll < NULL_RATE) {
          value[column.name] = null;
          return;
        }
        if (roll < NULL_RATE + ABSENT_RATE) return;
      }
      value[column.name] = pick(rng, pool);
    });
    return { id: `r${String(index).padStart(3, "0")}`, value };
  });
};

// ─── Operators ───────────────────────────────────────────────────────────────
//
// The operator core of ADR-0028: `eq ne lt lte gt gte in nin isnull` plus
// `and or not`. `nin` and `isnull` have no dedicated node yet (#155 adds
// `NotIn` and `IsNull`); until then they are generated through today's
// shapes. When those nodes land, only the two marked entries change.

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
  /** Needs an ordered kind: never applied to a boolean column. */
  readonly ordered: boolean;
  readonly build: (
    field: string,
    literal: () => Predicate.Literal,
    list: () => ReadonlyArray<Predicate.Literal>
  ) => Predicate.Predicate;
}

/** The leaf operator table: one constructor per core operator. */
export const leafOperators: ReadonlyArray<LeafOperator> = [
  { name: "eq", ordered: false, build: (field, literal) => Predicate.eq(field, literal()) },
  { name: "ne", ordered: false, build: (field, literal) => Predicate.ne(field, literal()) },
  { name: "gt", ordered: true, build: (field, literal) => Predicate.gt(field, literal()) },
  { name: "gte", ordered: true, build: (field, literal) => Predicate.gte(field, literal()) },
  { name: "lt", ordered: true, build: (field, literal) => Predicate.lt(field, literal()) },
  { name: "lte", ordered: true, build: (field, literal) => Predicate.lte(field, literal()) },
  { name: "in", ordered: false, build: (field, _literal, list) => Predicate.isIn(field, list()) },
  {
    name: "nin",
    ordered: false,
    // #155: replace with the `NotIn` node once it exists.
    build: (field, _literal, list) => Predicate.not(Predicate.isIn(field, list())),
  },
  {
    name: "isnull",
    ordered: false,
    // `eq(field, null)` is IS NULL in both JS and SQL today (`Sql.ts` null
    // special case). #155: replace with the `IsNull` node once it exists.
    build: (field) => Predicate.eq(field, null),
  },
];

// ─── Predicates ──────────────────────────────────────────────────────────────

const EMPTY_IN_RATE = 0.1;
const LEAF_RATE = 0.55;
const TRUE_RATE = 0.03;

const literalFor = (rng: Rng, pool: Pool): Predicate.Literal =>
  chance(rng, 0.3) && pool.foreign.length > 0 ? pick(rng, pool.foreign) : pick(rng, pool.rows);

const generateLeaf = (
  rng: Rng,
  columns: ReadonlyArray<Column>,
  options: ResolvedOptions,
  coverage: Coverage
): Predicate.Predicate => {
  if (chance(rng, TRUE_RATE)) {
    coverage.true++;
    return Predicate.always;
  }
  const column = pick(rng, columns);
  const pool = poolFor(column.kind, options);
  const candidates = leafOperators.filter((op) => !op.ordered || column.kind !== "boolean");
  const operator = pick(rng, candidates);
  coverage[operator.name]++;
  const literal = () => literalFor(rng, pool);
  const list = () =>
    chance(rng, EMPTY_IN_RATE) ? [] : Array.from({ length: 1 + int(rng, 4) }, literal);
  return operator.build(column.name, literal, list);
};

/**
 * Generate one depth-bounded predicate tree: leaves from the operator table
 * on a random column with a literal of that column's kind; `And`/`Or` with
 * 2–3 children and `Not` with one, down to `depth`. Emitted operators are
 * tallied into `coverage`.
 */
export const generatePredicate = (
  rng: Rng,
  columns: ReadonlyArray<Column>,
  options: CorpusOptions | undefined,
  coverage: Coverage,
  depth = 2
): Predicate.Predicate => {
  const resolved = resolveOptions(options);
  const go = (remaining: number): Predicate.Predicate => {
    if (remaining === 0 || chance(rng, LEAF_RATE)) {
      return generateLeaf(rng, columns, resolved, coverage);
    }
    const shape = int(rng, 3);
    if (shape === 2) {
      coverage.not++;
      return Predicate.not(go(remaining - 1));
    }
    const children = Array.from({ length: 2 + int(rng, 2) }, () => go(remaining - 1));
    if (shape === 0) {
      coverage.and++;
      return Predicate.and(...children);
    }
    coverage.or++;
    return Predicate.or(...children);
  };
  return go(depth);
};

// ─── Order terms ─────────────────────────────────────────────────────────────

/** Generate 1–2 `orderBy` terms over distinct columns with random directions. */
export const generateOrderBy = (
  rng: Rng,
  columns: ReadonlyArray<Column> = corpusColumns
): ReadonlyArray<Subset.OrderBy> => {
  const count = Math.min(columns.length, 1 + int(rng, 2));
  const remaining = [...columns];
  const terms: Array<Subset.OrderBy> = [];
  for (let n = 0; n < count; n++) {
    const index = int(rng, remaining.length);
    const [column] = remaining.splice(index, 1);
    terms.push({ field: column!.name, direction: chance(rng, 0.5) ? "asc" : "desc" });
  }
  return terms;
};

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

/** Generate a whole corpus deterministically from a seed. */
export const generateCorpus = (options: GenerateOptions): Corpus => {
  const rng = mulberry32(options.seed);
  const columns = options.columns ?? corpusColumns;
  const coverage = emptyCoverage();
  const rows = generateRows(rng, options.rows ?? 64, columns, options);
  const predicates = Array.from({ length: options.predicates ?? 200 }, () =>
    generatePredicate(rng, columns, options, coverage, options.depth ?? 2)
  );
  const orderBys = Array.from({ length: options.orderBys ?? 60 }, () =>
    generateOrderBy(rng, columns)
  );
  return { seed: options.seed, columns, rows, predicates, orderBys, coverage };
};

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
      return predicate.values.length > 1
        ? predicate.values.map((_, i) =>
            Predicate.isIn(predicate.field, without(predicate.values, i))
          )
        : [];
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
}

/**
 * Render a disagreement: the seed, the (minimal) predicate or order terms,
 * the (minimal) rows — absent keys stay absent, `null` prints as `null` —
 * and every subject's ids.
 */
export const formatDisagreement = (disagreement: Disagreement): string => {
  const lines = [
    `${disagreement.subject} (seed ${disagreement.seed}; set LEGATION_CORPUS_SEED to reproduce)`,
  ];
  if (disagreement.predicate !== undefined) {
    lines.push(`predicate: ${JSON.stringify(disagreement.predicate)}`);
  }
  if (disagreement.orderBy !== undefined) {
    lines.push(`orderBy: ${JSON.stringify(disagreement.orderBy)}`);
  }
  lines.push("rows:");
  for (const row of disagreement.rows) {
    lines.push(`  ${row.id} ${JSON.stringify(row.value)}`);
  }
  for (const [name, ids] of Object.entries(disagreement.results)) {
    lines.push(`${name}: ${JSON.stringify(ids)}`);
  }
  return lines.join("\n");
};
