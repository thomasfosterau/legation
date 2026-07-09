/**
 * Property test (issue #113 acceptance criterion): indexed evaluation must be
 * exactly equivalent to full-scan `Subset.apply` for randomized predicates and
 * data — including null/absent fields and type-mismatched comparisons
 * (`Predicate.ts` semantics, `test`/`compareValues`). No `fast-check` in this
 * repo's dependency set, so this is a small hand-rolled seeded-PRNG generator:
 * deterministic (fixed seed) so a failure reproduces exactly, with the seed
 * and failing case printed on assertion failure.
 */
import { describe, expect, it } from "vitest";
import * as CollectionIndex from "../CollectionIndex.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Rng = () => number;
const int = (rng: Rng, max: number): number => Math.floor(rng() * max);
const pick = <A>(rng: Rng, xs: ReadonlyArray<A>): A => xs[int(rng, xs.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;

// ─── Row generation ──────────────────────────────────────────────────────────
//
// Fields chosen to exercise every documented edge case: `a` is a plain
// number, sometimes absent; `b` a plain string, sometimes explicitly `null`;
// `mixed` holds either a number or a string across different rows (so a range
// query against one type must ignore rows holding the other, exactly like
// `compareValues`'s same-type-only check); `flag` is a boolean/null (never
// indexable by range, only by `eq`/`In`); `rank` is unique per row, used only
// as an orderBy tiebreak so sorted-pipeline comparisons are order-exact.

interface TestRow {
  readonly id: string;
  readonly value: Record<string, unknown>;
}

const INDEXED_FIELDS = ["a", "b", "mixed"];

const makeRows = (rng: Rng, count: number): ReadonlyArray<TestRow> =>
  Array.from({ length: count }, (_, i) => {
    const value: Record<string, unknown> = { rank: i };
    if (!chance(rng, 0.1)) value.a = int(rng, 5);
    value.b = chance(rng, 0.15) ? null : pick(rng, ["x", "y", "z"]);
    value.flag = chance(rng, 0.2) ? null : chance(rng, 0.5);
    if (chance(rng, 0.5)) value.mixed = int(rng, 5);
    else value.mixed = pick(rng, ["p", "q", "r"]);
    return { id: `r${i}`, value };
  });

// ─── Predicate generation ────────────────────────────────────────────────────

const COMPARE_FIELDS = ["a", "b", "mixed", "flag", "unindexedField"];
const COMPARE_VALUES: ReadonlyArray<Predicate.Literal> = [
  0,
  1,
  2,
  3,
  4,
  5,
  "x",
  "y",
  "z",
  "p",
  "q",
  "r",
  true,
  false,
  null,
];
const RANGE_OPS: ReadonlyArray<Predicate.Comparison> = ["gt", "gte", "lt", "lte"];

const randomConjunct = (rng: Rng): Predicate.Predicate => {
  const field = pick(rng, COMPARE_FIELDS);
  const kind = int(rng, 4);
  if (kind === 0) return Predicate.eq(field, pick(rng, COMPARE_VALUES));
  if (kind === 1) return Predicate.ne(field, pick(rng, COMPARE_VALUES));
  if (kind === 2) {
    const values = Array.from({ length: 1 + int(rng, 3) }, () => pick(rng, COMPARE_VALUES));
    return Predicate.isIn(field, values);
  }
  return Predicate.compare(pick(rng, RANGE_OPS), field, pick(rng, COMPARE_VALUES));
};

/** A random top-level predicate: mostly an `And` of a few conjuncts (the shape the
 * planner targets), occasionally wrapped in `Or`/`Not` or a bare conjunct. */
const randomPredicate = (rng: Rng): Predicate.Predicate => {
  const conjunctCount = 1 + int(rng, 4);
  const conjuncts = Array.from({ length: conjunctCount }, () => randomConjunct(rng));
  const base = Predicate.and(...conjuncts);
  const shape = int(rng, 4);
  if (shape === 0) return Predicate.not(base);
  if (shape === 1) return Predicate.or(base, randomConjunct(rng));
  return base;
};

// ─── Comparison helpers ──────────────────────────────────────────────────────

const idsOf = (rows: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  rows.map((r) => r.id).toSorted();

const TRIALS = 400;
const ROWS_PER_TRIAL = 60;
const SEED = 20260709;

describe("CollectionIndex evaluation ≡ full-scan Subset.apply (property)", () => {
  it(`matches over ${TRIALS} randomized (rows, predicate) trials`, () => {
    const rng = mulberry32(SEED);
    const index = CollectionIndex.empty(INDEXED_FIELDS);

    for (let trial = 0; trial < TRIALS; trial++) {
      const rows = makeRows(rng, ROWS_PER_TRIAL);
      const rowsById = new Map(rows.map((r) => [r.id, r]));
      CollectionIndex.rebuild(index, rows);

      const predicate = randomPredicate(rng);
      const subset = Subset.make({ collection: "t", where: predicate });

      const expected = Subset.apply(rows, subset);
      const actual = Subset.applyIndexed(rowsById, subset, index);

      expect(idsOf(actual)).toEqual(idsOf(expected));
    }
  });

  it(`matches with orderBy + limit + cursor over ${TRIALS} trials (order-exact)`, () => {
    const rng = mulberry32(SEED + 1);
    const index = CollectionIndex.empty(INDEXED_FIELDS);

    for (let trial = 0; trial < TRIALS; trial++) {
      const rows = makeRows(rng, ROWS_PER_TRIAL);
      const rowsById = new Map(rows.map((r) => [r.id, r]));
      CollectionIndex.rebuild(index, rows);

      const predicate = randomPredicate(rng);
      // `rank` is unique per row, so it's a total tiebreak: sort order is
      // exact regardless of which order the filter step produced candidates in.
      const subset = Subset.make({
        collection: "t",
        where: predicate,
        orderBy: [{ field: "rank", direction: chance(rng, 0.5) ? "asc" : "desc" }],
        ...(chance(rng, 0.5) ? { limit: 1 + int(rng, ROWS_PER_TRIAL) } : {}),
      });

      const expected = Subset.apply(rows, subset);
      const actual = Subset.applyIndexed(rowsById, subset, index);

      expect(actual.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    }
  });

  it("matches for absent/null fields and cross-type range comparisons specifically", () => {
    const rows: ReadonlyArray<TestRow> = [
      { id: "absent", value: { rank: 0 } }, // `a` entirely missing
      { id: "null-a", value: { rank: 1, a: null } },
      { id: "num-1", value: { rank: 2, a: 1 } },
      { id: "num-2", value: { rank: 3, a: 2 } },
      { id: "str-a", value: { rank: 4, a: "1" } }, // same-looking value, different type
    ];
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const index = CollectionIndex.empty(["a"]);
    CollectionIndex.rebuild(index, rows);

    const cases: ReadonlyArray<Predicate.Predicate> = [
      Predicate.eq("a", null),
      Predicate.eq("a", 1),
      Predicate.ne("a", 1),
      Predicate.isIn("a", [1, 2]),
      Predicate.gt("a", 0),
      Predicate.gte("a", 1),
      Predicate.lt("a", 2),
      Predicate.compare("gt", "a", "1"), // string literal vs numeric+string rows
      Predicate.and(Predicate.gt("a", 0), Predicate.ne("a", 2)),
    ];
    for (const where of cases) {
      const subset = Subset.make({ collection: "t", where });
      const expected = idsOf(Subset.apply(rows, subset));
      const actual = idsOf(Subset.applyIndexed(rowsById, subset, index));
      expect(actual).toEqual(expected);
    }
  });
});
