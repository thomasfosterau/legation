/**
 * FilterCorpus generator tests (issue #153): the corpus is deterministic per
 * seed, covers every operator in the ADR-0028 core and every literal kind of
 * rule (e) at the default seed, never crosses types (rule (d)), never emits
 * `Exists`, and the minimiser shrinks a disagreement to its smallest
 * reproducing predicate/row pair.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as FilterCorpus from "../FilterCorpus.js";
import * as Predicate from "../Predicate.js";
import { defined } from "./defined.js";

const kindOf = (literal: Predicate.Literal, column: FilterCorpus.Column): boolean => {
  switch (column.kind) {
    case "text":
    case "instant":
      return P.isString(literal);
    case "integer":
      return P.isNumber(literal) && Number.isInteger(literal);
    case "double":
      return P.isNumber(literal) && Number.isFinite(literal);
    case "boolean":
      return P.isBoolean(literal);
  }
};

/** Every (field, literal) pair at the leaves of a predicate. */
const leaves = (
  predicate: Predicate.Predicate
): ReadonlyArray<{ readonly field: string; readonly literal: Predicate.Literal }> => {
  switch (predicate._tag) {
    case "Compare":
      return [{ field: predicate.field, literal: predicate.value }];
    case "In":
    case "NotIn":
      return predicate.values.map((literal) => ({ field: predicate.field, literal }));
    case "IsNull":
      return [];
    case "And":
    case "Or":
      return predicate.predicates.flatMap(leaves);
    case "Not":
      return leaves(predicate.predicate);
    case "True":
      return [];
    case "Exists":
      throw new Error("Exists must never be generated");
  }
};

describe("FilterCorpus", () => {
  const generate = (options: FilterCorpus.GenerateOptions) =>
    Effect.runSync(FilterCorpus.generateCorpus(options));
  const corpus = generate({ seed: FilterCorpus.DEFAULT_SEED });

  it("is deterministic for a seed", () => {
    const again = generate({ seed: FilterCorpus.DEFAULT_SEED });
    expect(again).toEqual(corpus);
    const other = generate({ seed: FilterCorpus.DEFAULT_SEED + 1 });
    expect(other.predicates).not.toEqual(corpus.predicates);
  });

  it("reproduces the same corpus on every run of one generateCorpus effect", () => {
    // `Random.withSeed` builds its generator when the effect is constructed;
    // `generateCorpus` suspends that, so re-running one effect value does not
    // continue the previous run's sequence.
    const once = FilterCorpus.generateCorpus({ seed: FilterCorpus.DEFAULT_SEED });
    expect(Effect.runSync(once)).toEqual(Effect.runSync(once));
  });

  it("resolves the seed from LEGATION_CORPUS_SEED", () => {
    expect(FilterCorpus.resolveSeed(undefined)).toBe(FilterCorpus.DEFAULT_SEED);
    expect(FilterCorpus.resolveSeed("")).toBe(FilterCorpus.DEFAULT_SEED);
    expect(FilterCorpus.resolveSeed("42")).toBe(42);
    expect(() => FilterCorpus.resolveSeed("nope")).toThrow(/LEGATION_CORPUS_SEED/);
  });

  it("covers every operator at the default seed", () => {
    const names = Object.keys(
      FilterCorpus.emptyCoverage()
    ) as ReadonlyArray<FilterCorpus.OperatorName>;
    // `true` is deliberately rare; everything else must recur.
    const thin = names.filter((name) => corpus.coverage[name] < (name === "true" ? 1 : 10));
    expect(thin).toEqual([]);
  });

  it("covers every literal kind, NULL, absent, boundary numerics, and astral text", () => {
    const seen = new Set<string>();
    Arr.forEach(corpus.rows, (row) => {
      Arr.forEach(corpus.columns, (column) => {
        if (!(column.name in row.value)) seen.add(`${column.name}:absent`);
        else if (row.value[column.name] === null) seen.add(`${column.name}:null`);
        else seen.add(`${column.name}:${column.kind}`);
      });
    });
    Arr.forEach(corpus.columns, (column) => {
      expect(seen).toContain(`${column.name}:absent`);
      expect(seen).toContain(`${column.name}:null`);
      expect(seen).toContain(`${column.name}:${column.kind}`);
    });
    const strings = corpus.rows.map((row) => row.value.s).filter(P.isString);
    expect(strings).toContain("");
    expect(strings.some((s) => /[\u{10000}-\u{10FFFF}]/u.test(s))).toBe(true);
    expect(strings.some((s) => /^[-￿]+$/u.test(s))).toBe(true);
    const ints = corpus.rows.map((row) => row.value.i).filter(P.isNumber);
    expect(ints).toContain(2147483647);
    expect(ints).toContain(-2147483648);
    const doubles = corpus.rows.map((row) => row.value.d).filter(P.isNumber);
    expect(doubles.some((d) => d >= 2 ** 53 - 1)).toBe(true);
    expect(doubles.every(Number.isFinite)).toBe(true);
  });

  it("never compares a column against a literal of another kind (rule d)", () => {
    const columns = new Map(corpus.columns.map((column) => [column.name, column]));
    const allLeaves = corpus.predicates.flatMap(leaves);
    expect(allLeaves.length).toBeGreaterThan(0);
    const unknownFields = allLeaves.filter((leaf) => !columns.has(leaf.field));
    expect(unknownFields).toEqual([]);
    const crossTyped = allLeaves.filter(
      (leaf) => leaf.literal !== null && !kindOf(leaf.literal, defined(columns.get(leaf.field)))
    );
    expect(crossTyped).toEqual([]);
  });

  it("honours { nulls: false, astral: false }", () => {
    const restricted = generate({
      seed: FilterCorpus.DEFAULT_SEED,
      nulls: false,
      astral: false,
    });
    Arr.forEach(restricted.rows, (row) => {
      Arr.forEach(restricted.columns, (column) => {
        expect(row.value[column.name]).not.toBeNull();
        expect(row.value[column.name]).not.toBeUndefined();
      });
    });
    const astral = restricted.rows.filter(
      (row) => P.isString(row.value.s) && /[\u{10000}-\u{10FFFF}]/u.test(row.value.s)
    );
    expect(astral).toEqual([]);
    // `isnull` over rows with no NULL/absent field is a constant predicate;
    // it is not generated, so its coverage requires `nulls`.
    expect(restricted.coverage.isnull).toBe(0);
    expect(corpus.coverage.isnull).toBeGreaterThan(0);
  });

  it("refuses a row count below the guaranteed sweep", () => {
    const minimum = FilterCorpus.minimumRows();
    // Two pinned rows plus the widest pool (the string column with astral text).
    expect(minimum).toBeGreaterThan(2);
    expect(() => generate({ seed: FilterCorpus.DEFAULT_SEED, rows: minimum - 1 })).toThrow(
      new RegExp(`at least ${minimum} rows`)
    );
    expect(generate({ seed: FilterCorpus.DEFAULT_SEED, rows: minimum }).rows).toHaveLength(minimum);
    expect(FilterCorpus.minimumRows(corpus.columns, { nulls: false })).toBe(minimum - 2);
  });

  it("prints -0 distinctly in a disagreement report", () => {
    const report = FilterCorpus.formatDisagreement({
      seed: 1,
      subject: "js disagrees with postgres",
      predicate: Predicate.eq("d", -0),
      rows: [{ id: "r0", value: { d: -0 } }],
      results: { postgres: ["r0"], js: [] },
    });
    expect(report).toContain('predicate: {"_tag":"Compare","op":"eq","field":"d","value":"-0"}');
    expect(report).toContain('  r0 {"d":"-0"}');
  });

  it("generates 1–2 orderBy terms over distinct columns", () => {
    Arr.forEach(corpus.orderBys, (orderBy) => {
      expect(orderBy.length).toBeGreaterThanOrEqual(1);
      expect(orderBy.length).toBeLessThanOrEqual(2);
      expect(new Set(orderBy.map((term) => term.field)).size).toBe(orderBy.length);
    });
  });

  it("minimises a disagreement to the smallest reproducing predicate and rows", async () => {
    // A stand-in "subject" that disagrees with the reference exactly when a
    // `ne` on `s` meets a NULL row: the JS two-valued `!==` versus SQL's
    // three-valued `<>` (ADR-0028 rule (a)).
    const disagrees = (candidate: FilterCorpus.Case) =>
      Effect.sync(() => {
        const hasNe =
          Arr.isReadonlyArrayNonEmpty(leaves(candidate.predicate)) &&
          JSON.stringify(candidate.predicate).includes('"op":"ne"');
        return hasNe && candidate.rows.some((row) => row.value.s === null);
      });
    const failing: FilterCorpus.Case = {
      predicate: Predicate.and(
        Predicate.or(Predicate.ne("s", "a"), Predicate.gt("i", 3)),
        Predicate.not(Predicate.isIn("t", ["x", "y"]))
      ),
      rows: [
        { id: "r0", value: { s: "a" } },
        { id: "r1", value: { s: null } },
        { id: "r2", value: {} },
      ],
    };
    const minimal = await Effect.runPromise(FilterCorpus.minimise(failing, disagrees));
    expect(minimal.predicate).toEqual(Predicate.ne("s", "a"));
    expect(minimal.rows).toEqual([{ id: "r1", value: { s: null } }]);
  });
});
