/**
 * Property test (issue #113 acceptance criterion): indexed evaluation must be
 * exactly equivalent to full-scan `Subset.apply` for randomized predicates and
 * data — including null/absent fields and type-mismatched comparisons
 * (`Predicate.ts` semantics: `evaluate` under ADR-0028, where absent ≡ NULL
 * and a NULL field makes every comparison unknown). No `fast-check` in this
 * repo's dependency set, so this is a small hand-rolled seeded-PRNG generator:
 * deterministic (fixed seed) so a failure reproduces exactly, with the seed
 * and failing case printed on assertion failure. The last block runs the
 * same equivalence over the differential harness corpus (`FilterCorpus`,
 * #153) with NULL, absent and astral text on — ADR-0028's acceptance
 * criterion for the index.
 */
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import * as CollectionIndex from "../CollectionIndex.js";
import * as FilterCorpus from "../FilterCorpus.js";
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
// rule (d)'s unknown on a type mismatch); `flag` is a boolean/null (ADR-0028
// orders booleans `false < true`, so it is range-indexable too); `rank` is
// unique per row, used only as an orderBy tiebreak so sorted-pipeline
// comparisons are order-exact. Absent `a`, null `b` and null `flag` rows are
// generated on purpose: under ADR-0028 rule (b) they share the index's NULL
// bucket, which only `IsNull` may return.

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
  const kind = int(rng, 6);
  // `eq`/`ne` with `null` desugar to `IsNull` / negated `IsNull` (ADR-0028).
  if (kind === 0) return Predicate.eq(field, pick(rng, COMPARE_VALUES));
  if (kind === 1) return Predicate.ne(field, pick(rng, COMPARE_VALUES));
  if (kind === 2 || kind === 3) {
    const values = Array.from({ length: int(rng, 4) }, () => pick(rng, COMPARE_VALUES));
    return kind === 2 ? Predicate.isIn(field, values) : Predicate.notIn(field, values);
  }
  // A raw `Compare` may carry `null`: unknown for every row, never a match.
  if (kind === 4) return Predicate.compare(pick(rng, RANGE_OPS), field, pick(rng, COMPARE_VALUES));
  return Predicate.compare("eq", field, pick(rng, COMPARE_VALUES));
};

/** A random top-level predicate: mostly an `And` of a few conjuncts (the shape the
 * planner targets), occasionally wrapped in `Or`/`Not` or a bare conjunct. */
const randomPredicate = (rng: Rng): Predicate.Predicate => {
  const conjunctCount = 1 + int(rng, 4);
  const conjuncts = Array.from({ length: conjunctCount }, () => randomConjunct(rng));
  const base = Predicate.and(...conjuncts);
  const wrapper = int(rng, 4);
  if (wrapper === 0) return Predicate.not(base);
  if (wrapper === 1) return Predicate.or(base, randomConjunct(rng));
  return base;
};

// ─── Comparison helpers ──────────────────────────────────────────────────────

const idsOf = (rows: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  rows.map((r) => r.id).toSorted();
const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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
      // ADR-0028: `eq("a", null)` is `IsNull("a")`, selecting the absent row
      // and the null row alike (it used to select only the explicit null).
      Predicate.eq("a", null),
      Predicate.isNull("a"),
      Predicate.isNotNull("a"),
      Predicate.compare("eq", "a", null), // wire form: unknown everywhere
      Predicate.eq("a", 1),
      Predicate.ne("a", 1),
      Predicate.isIn("a", [1, 2]),
      Predicate.isIn("a", [1, null]),
      Predicate.notIn("a", [1]),
      Predicate.notIn("a", []),
      Predicate.gt("a", 0),
      Predicate.gte("a", 1),
      Predicate.lt("a", 2),
      Predicate.compare("gt", "a", "1"), // string literal vs numeric+string rows
      Predicate.and(Predicate.gt("a", 0), Predicate.ne("a", 2)),
      Predicate.and(Predicate.isNull("a"), Predicate.gt("rank", 0)),
    ];
    const mismatches = cases.flatMap((where) => {
      const subset = Subset.make({ collection: "t", where });
      const expected = idsOf(Subset.apply(rows, subset));
      const actual = idsOf(Subset.applyIndexed(rowsById, subset, index));
      return JSON.stringify(actual) === JSON.stringify(expected)
        ? []
        : [{ where, expected, actual }];
    });
    expect(mismatches).toEqual([]);
    // The ADR-0028 rule (b) answer, stated outright.
    expect(
      idsOf(
        Subset.applyIndexed(
          rowsById,
          Subset.make({ collection: "t", where: Predicate.eq("a", null) }),
          index
        )
      )
    ).toEqual(["absent", "null-a"]);
  });

  it("matches the full scan over the differential corpus (NULL, absent, astral text)", () => {
    // Every corpus column is indexed, so every `eq`/`In`/`IsNull`/range leaf
    // at the top level of an `And` is planned through the index; `ne`,
    // `NotIn`, negated `IsNull`, `Or` and `Not` stay residual.
    const corpus = Effect.runSync(
      FilterCorpus.generateCorpus({
        seed: FilterCorpus.DEFAULT_SEED,
        nulls: true,
        astral: true,
        booleanOrder: true,
        predicates: 400,
      })
    );
    const index = CollectionIndex.empty(corpus.columns.map((column) => column.name));
    CollectionIndex.rebuild(index, corpus.rows);
    const rowsById = new Map(corpus.rows.map((row) => [row.id, row]));
    const fullScan = (where: Predicate.Predicate) =>
      idsOf(corpus.rows.filter((row) => Predicate.test(where, row.value)));
    /** Every predicate where the index (planned or fallen back) disagrees with the full scan. */
    const disagreements = (predicates: ReadonlyArray<Predicate.Predicate>) =>
      predicates.flatMap((where) => {
        const expected = fullScan(where);
        const viaIndex = CollectionIndex.evaluate(index, rowsById, where);
        const planned = viaIndex === undefined ? expected : idsOf(viaIndex);
        const subset = Subset.make({ collection: "corpus", where });
        const applied = idsOf(Subset.applyIndexed(rowsById, subset, index));
        return same(planned, expected) && same(applied, expected)
          ? []
          : [{ where, expected, planned, applied }];
      });

    expect(disagreements(corpus.predicates)).toEqual([]);
    // The index must actually have been exercised, not bypassed.
    const planned = corpus.predicates.filter(
      (where) => CollectionIndex.plan(index, where) !== undefined
    );
    expect(planned.length).toBeGreaterThan(100);

    // Incremental maintenance agrees with the rebuild: move every row through
    // a NULL and back, then re-check a slice of the predicates.
    for (const row of corpus.rows) {
      CollectionIndex.upsertRow(index, row.id, {});
      CollectionIndex.upsertRow(index, row.id, row.value);
    }
    expect(disagreements(corpus.predicates.slice(0, 100))).toEqual([]);
  });
});
