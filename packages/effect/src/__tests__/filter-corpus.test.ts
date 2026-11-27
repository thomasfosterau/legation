/**
 * FilterCorpus generator tests: over generated seeds the corpus is
 * deterministic, never crosses types (rule (d)), never emits `Exists` and
 * honours its options; at the default seed it covers every operator in the
 * ADR-0028 core and every literal kind of rule (e); the minimiser shrinks a
 * disagreement to a case no single shrink still reproduces.
 */
import * as Result from "effect/Result";
import { expect, it as base, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as FilterCorpus from "../FilterCorpus.js";
import * as Predicate from "../Predicate.js";
import { defined } from "./defined.js";
import { TestFailure } from "./test-failure.js";
import * as Json from "../internal/Json.js";

const kindOf = (literal: Predicate.Literal, column: FilterCorpus.Column): boolean =>
  Match.value(column.kind).pipe(
    Match.whenOr("text", "instant", () => P.isString(literal)),
    Match.when("integer", () => P.isNumber(literal) && Number.isInteger(literal)),
    Match.when("double", () => P.isNumber(literal) && Number.isFinite(literal)),
    Match.when("boolean", () => P.isBoolean(literal)),
    Match.exhaustive
  );

/** Every (field, literal) pair at the leaves of a predicate. */
const leaves = (
  predicate: Predicate.Predicate
): ReadonlyArray<{ readonly field: string; readonly literal: Predicate.Literal }> =>
  Match.value(predicate).pipe(
    Match.withReturnType<
      ReadonlyArray<{ readonly field: string; readonly literal: Predicate.Literal }>
    >(),
    Match.tag("Compare", (node) => [{ field: node.field, literal: node.value }]),
    Match.tag("In", "NotIn", (node) =>
      node.values.map((literal) => ({ field: node.field, literal }))
    ),
    Match.tag("IsNull", () => []),
    Match.tag("And", "Or", (node) => node.predicates.flatMap(leaves)),
    Match.tag("Not", (node) => leaves(node.predicate)),
    Match.tag("True", () => []),
    Match.tag("Exists", () => {
      throw new TestFailure({ message: "Exists must never be generated" });
    }),
    Match.tag("InSet", () => {
      throw new TestFailure({ message: "InSet must never be generated" });
    }),
    Match.exhaustive
  );

const generate = (options: FilterCorpus.GenerateOptions) => FilterCorpus.generateCorpus(options);

/** Any seed `LEGATION_CORPUS_SEED` can name. */
const Seed = Schema.Int.check(Schema.isInt32());

/** A corpus small enough to build once per generated seed. */
const small = (seed: number, options?: FilterCorpus.CorpusOptions) =>
  generate({ seed, predicates: 40, orderBys: 20, ...options });

/** Runs per seed property: each builds at least one corpus. */
const seedRuns = { arbitrary: { runs: 25 } };

/** The corpus at the default seed, built once for the suite. */
class DefaultCorpus extends Context.Service<DefaultCorpus, FilterCorpus.Corpus>()(
  "test/FilterCorpus/DefaultCorpus"
) {
  static readonly layer = Layer.effect(DefaultCorpus)(
    generate({ seed: FilterCorpus.DEFAULT_SEED })
  );
}

// A stand-in "subject" that disagrees with the reference exactly when a
// `ne` on `s` meets a NULL row: the JS two-valued `!==` versus SQL's
// three-valued `<>` (ADR-0028 rule (a)).
const disagrees = (candidate: FilterCorpus.Case) =>
  Effect.sync(() => {
    const hasNe =
      Arr.isReadonlyArrayNonEmpty(leaves(candidate.predicate)) &&
      Json.show(candidate.predicate).includes('"op":"ne"');
    return hasNe && candidate.rows.some((row) => row.value.s === null);
  });

base.describe("FilterCorpus over generated seeds", () => {
  base.effect.prop(
    "is deterministic for a seed, and another seed draws other predicates",
    [Seed],
    ([seed]) =>
      Effect.gen(function* () {
        const corpus = yield* small(seed);
        expect(yield* small(seed)).toEqual(corpus);
        const other = yield* small(seed === 0 ? 1 : -seed);
        expect(other.predicates).not.toEqual(corpus.predicates);
      }),
    seedRuns
  );

  base.effect.prop(
    "never compares a column against a literal of another kind (rule d)",
    [Seed, Schema.Boolean, Schema.Boolean],
    ([seed, nulls, astral]) =>
      Effect.gen(function* () {
        const corpus = yield* small(seed, { nulls, astral });
        const columns = HashMap.fromIterable(corpus.columns.map((column) => [column.name, column]));
        // `leaves` throws on `Exists` and `InSet`, so this also checks neither is generated.
        const allLeaves = corpus.predicates.flatMap(leaves);
        expect(allLeaves.length).toBeGreaterThan(0);
        expect(allLeaves.filter((leaf) => !HashMap.has(columns, leaf.field))).toEqual([]);
        const crossTyped = allLeaves.filter(
          (leaf) =>
            leaf.literal !== null &&
            !kindOf(leaf.literal, defined(Option.getOrUndefined(HashMap.get(columns, leaf.field))))
        );
        expect(crossTyped).toEqual([]);
      }),
    seedRuns
  );

  base.effect.prop(
    "honours { nulls: false, astral: false }",
    [Seed],
    ([seed]) =>
      Effect.gen(function* () {
        const restricted = yield* small(seed, { nulls: false, astral: false });
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
        // `isnull` over rows with no NULL/absent field is a constant predicate,
        // so it is not generated.
        expect(restricted.coverage.isnull).toBe(0);
      }),
    seedRuns
  );

  base.effect.prop(
    "generates 1–2 orderBy terms over distinct columns",
    [Seed],
    ([seed]) =>
      Effect.gen(function* () {
        const corpus = yield* small(seed);
        Arr.forEach(corpus.orderBys, (orderBy) => {
          expect(orderBy.length).toBeGreaterThanOrEqual(1);
          expect(orderBy.length).toBeLessThanOrEqual(2);
          expect(Arr.dedupe(orderBy.map((term) => term.field)).length).toBe(orderBy.length);
        });
      }),
    seedRuns
  );

  base.effect.prop(
    "minimises a disagreement to a case no single shrink still reproduces",
    [Seed],
    ([seed]) =>
      Effect.gen(function* () {
        const corpus = yield* small(seed);
        const failing = yield* Effect.findFirst(
          corpus.predicates.map((predicate) => ({ predicate, rows: corpus.rows })),
          disagrees
        );
        if (Option.isNone(failing)) return;
        const minimal = yield* FilterCorpus.minimise(failing.value, disagrees);
        expect(yield* disagrees(minimal)).toBe(true);
        const further = [
          ...FilterCorpus.shrinkPredicate(minimal.predicate).map((predicate) => ({
            predicate,
            rows: minimal.rows,
          })),
          ...minimal.rows.map((_, i) => ({
            predicate: minimal.predicate,
            rows: minimal.rows.filter((__, j) => j !== i),
          })),
        ];
        const reproducing = yield* Effect.filter(further, disagrees);
        expect(reproducing).toEqual([]);
      }),
    seedRuns
  );
});

layer(DefaultCorpus.layer)("FilterCorpus", (it) => {
  it.effect("is deterministic for the default seed", () =>
    Effect.gen(function* () {
      const corpus = yield* DefaultCorpus;
      expect(yield* generate({ seed: FilterCorpus.DEFAULT_SEED })).toEqual(corpus);
    })
  );

  it.effect("reproduces the same corpus on every run of one generateCorpus effect", () =>
    Effect.gen(function* () {
      // `Random.withSeed` builds its generator when the effect is constructed;
      // `generateCorpus` suspends that, so re-running one effect value does not
      // continue the previous run's sequence.
      const once = FilterCorpus.generateCorpus({ seed: FilterCorpus.DEFAULT_SEED });
      expect(yield* once).toEqual(yield* once);
    })
  );

  it("resolves the seed from LEGATION_CORPUS_SEED", () => {
    expect(FilterCorpus.resolveSeed(undefined)).toEqual(Result.succeed(FilterCorpus.DEFAULT_SEED));
    expect(FilterCorpus.resolveSeed("")).toEqual(Result.succeed(FilterCorpus.DEFAULT_SEED));
    expect(FilterCorpus.resolveSeed("42")).toEqual(Result.succeed(42));
    const refused = FilterCorpus.resolveSeed("nope");
    expect(Result.isFailure(refused) && refused.failure.message).toMatch(/LEGATION_CORPUS_SEED/);
  });

  it.effect("covers every operator at the default seed", () =>
    Effect.gen(function* () {
      const corpus = yield* DefaultCorpus;
      const names = R.keys(FilterCorpus.emptyCoverage());
      // `true` is deliberately rare; everything else must recur.
      const thin = names.filter((name) => corpus.coverage[name] < (name === "true" ? 1 : 10));
      expect(thin).toEqual([]);
    })
  );

  it.effect("covers every literal kind, NULL, absent, boundary numerics, and astral text", () =>
    Effect.gen(function* () {
      const corpus = yield* DefaultCorpus;
      const seen = MutableHashSet.empty<string>();
      Arr.forEach(corpus.rows, (row) => {
        Arr.forEach(corpus.columns, (column) => {
          if (!(column.name in row.value)) MutableHashSet.add(seen, `${column.name}:absent`);
          else if (row.value[column.name] === null) MutableHashSet.add(seen, `${column.name}:null`);
          else MutableHashSet.add(seen, `${column.name}:${column.kind}`);
        });
      });
      Arr.forEach(corpus.columns, (column) => {
        expect([...seen]).toContain(`${column.name}:absent`);
        expect([...seen]).toContain(`${column.name}:null`);
        expect([...seen]).toContain(`${column.name}:${column.kind}`);
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
    })
  );

  it.effect("covers isnull only with nulls on", () =>
    Effect.gen(function* () {
      const corpus = yield* DefaultCorpus;
      const restricted = yield* generate({ seed: FilterCorpus.DEFAULT_SEED, nulls: false });
      expect(restricted.coverage.isnull).toBe(0);
      expect(corpus.coverage.isnull).toBeGreaterThan(0);
    })
  );

  it.effect("refuses a row count below the guaranteed sweep", () =>
    Effect.gen(function* () {
      const corpus = yield* DefaultCorpus;
      const minimum = FilterCorpus.minimumRows();
      // Two pinned rows plus the widest pool (the string column with astral text).
      expect(minimum).toBeGreaterThan(2);
      const refused = yield* Effect.flip(
        generate({ seed: FilterCorpus.DEFAULT_SEED, rows: minimum - 1 })
      );
      expect(refused._tag).toBe("InvalidCorpusInput");
      expect(refused.message).toMatch(new RegExp(`at least ${minimum} rows`));
      const swept = yield* generate({ seed: FilterCorpus.DEFAULT_SEED, rows: minimum });
      expect(swept.rows).toHaveLength(minimum);
      expect(FilterCorpus.minimumRows(corpus.columns, { nulls: false })).toBe(minimum - 2);
    })
  );

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

  it.effect("minimises a disagreement to the smallest reproducing predicate and rows", () =>
    Effect.gen(function* () {
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
      const minimal = yield* FilterCorpus.minimise(failing, disagrees);
      expect(minimal.predicate).toEqual(Predicate.ne("s", "a"));
      expect(minimal.rows).toEqual([{ id: "r1", value: { s: null } }]);
    })
  );
});
