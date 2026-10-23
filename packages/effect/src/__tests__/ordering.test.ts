/**
 * Ordering under ADR-0028: `Predicate.compareText` is code-point order
 * (property-tested against a reference that compares `Array.from(s)` code
 * points), and `Subset.comparator` places NULL/absent last ascending and
 * first descending with a code-point id tie-break. The differential harness
 * in `@thomasfosterau/legation-sql` checks the same against Postgres `ORDER BY … COLLATE
 * "C"`; this file pins the JS side on its own. Random strings come from
 * Effect's seeded `Random` service (`Random.withSeed`), the repo's idiom.
 */
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { describe, expect, it } from "vite-plus/test";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import { defined } from "./defined.js";

// ─── Reference ───────────────────────────────────────────────────────────────

/** Code-point order by construction: compare the arrays `Array.from` yields. */
const referenceCompare = (a: string, b: string): number => {
  const xs = Array.from(a, (c) => defined(c.codePointAt(0)));
  const ys = Array.from(b, (c) => defined(c.codePointAt(0)));
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (xs[i] !== ys[i]) return defined(xs[i]) < defined(ys[i]) ? -1 : 1;
  }
  return xs.length === ys.length ? 0 : xs.length < ys.length ? -1 : 1;
};

/** UTF-16 code-unit order (JS `<`), the order this ADR moves away from. */
const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

// ─── Random strings ──────────────────────────────────────────────────────────
//
// Alphabet chosen to hit every boundary: ASCII, BMP below and above the
// surrogate range (U+E000–U+FFFF is where code-unit and code-point order
// disagree), astral characters, and lone surrogates (invalid, but a JS
// string can hold them; both orders must still agree on them).

const ALPHABET: ReadonlyArray<string> = [
  "a",
  "b",
  " ",
  "\u0000",
  "é",
  "퟿",
  "",
  "�",
  "￿",
  "\u{10000}",
  "😀",
  "\u{10FFFF}",
  "\uD800",
  "\uDFFF",
];

const randomString: Effect.Effect<string> = Effect.gen(function* () {
  const length = yield* Random.nextIntBetween(0, 5, { halfOpen: true });
  const chars = yield* Random.choice(ALPHABET).pipe(Effect.orDie, Effect.replicateEffect(length));
  return chars.join("");
});

const TRIALS = 5000;
const SEED = 20260903;

/** `TRIALS` random string pairs, deterministic for `SEED`. */
const randomPairs: ReadonlyArray<readonly [string, string]> = Effect.runSync(
  Effect.all([randomString, randomString])
    .pipe(Effect.replicateEffect(TRIALS))
    .pipe(Random.withSeed(SEED))
);

describe("Predicate.compareText (ADR-0028 rule (c))", () => {
  it(`agrees with the Array.from code-point reference over ${TRIALS} random pairs`, () => {
    let divergedFromCodeUnits = 0;
    const mismatches: Array<{ a: string; b: string; actual: number; expected: number }> = [];
    for (const [a, b] of randomPairs) {
      const actual = sign(Predicate.compareText(a, b));
      const expected = sign(referenceCompare(a, b));
      // Agreement with the reference, antisymmetry and reflexivity.
      if (
        actual !== expected ||
        sign(Predicate.compareText(b, a)) !== sign(-actual) ||
        Predicate.compareText(a, a) !== 0
      ) {
        mismatches.push({ a, b, actual, expected });
      }
      if (actual !== sign(codeUnitCompare(a, b))) divergedFromCodeUnits++;
    }
    // Reproduce any failure with `SEED`; the offending pair prints here.
    expect(mismatches).toEqual([]);
    // The generator does exercise the region where the two orders differ.
    expect(divergedFromCodeUnits).toBeGreaterThan(0);
  });

  it("orders the known boundary cases", () => {
    expect(Predicate.compareText("￿", "😀")).toBe(-1); // U+FFFF < U+1F600
    // oxlint-disable-next-line no-constant-binary-expression -- the literal comparison is the point: code units say the opposite
    expect("￿" < "😀").toBe(false); // code units say the opposite
    expect(Predicate.compareText("", "\u{10000}")).toBe(-1);
    expect(Predicate.compareText("a", "a😀")).toBe(-1);
    expect(Predicate.compareText("😀", "😀")).toBe(0);
    expect(Predicate.compareText("", "")).toBe(0);
    expect(Predicate.compareText("", "\u0000")).toBe(-1);
    expect(Predicate.compareText("😀", "😁")).toBe(-1);
  });

  it("compareLiterals orders numbers, text and booleans, and refuses mismatches", () => {
    expect(Predicate.compareLiterals(1, 2)).toBe(-1);
    expect(Predicate.compareLiterals(-0, 0)).toBe(0);
    expect(Predicate.compareLiterals("b", "a")).toBe(1);
    expect(Predicate.compareLiterals(false, true)).toBe(-1);
    expect(Predicate.compareLiterals(true, true)).toBe(0);
    expect(Predicate.compareLiterals(1, "1")).toBeUndefined();
    expect(Predicate.compareLiterals(null, null)).toBeUndefined();
    expect(Predicate.compareLiterals(true, 1)).toBeUndefined();
  });
});

describe("Subset.comparator (ADR-0028 section 4)", () => {
  const rows: ReadonlyArray<Subset.Row> = [
    { id: "r1", value: { s: "b" } },
    { id: "r2", value: { s: null } },
    { id: "r3", value: { s: "a" } },
    { id: "r4", value: {} },
    { id: "r5", value: { s: "😀" } },
    { id: "r6", value: { s: "￿" } },
  ];
  const ids = (orderBy: ReadonlyArray<Subset.OrderBy>) =>
    rows.toSorted(Subset.comparator(orderBy)).map((row) => row.id);

  it("sorts NULL and absent last ascending and first descending, text by code point", () => {
    expect(ids([{ field: "s", direction: "asc" }])).toEqual(["r3", "r1", "r6", "r5", "r2", "r4"]);
    expect(ids([{ field: "s", direction: "desc" }])).toEqual(["r2", "r4", "r5", "r6", "r1", "r3"]);
  });

  it("orders booleans false < true and numbers numerically", () => {
    const mixed: ReadonlyArray<Subset.Row> = [
      { id: "t", value: { b: true, n: 10 } },
      { id: "f", value: { b: false, n: 9 } },
      { id: "z", value: { n: null } },
    ];
    expect(
      mixed.toSorted(Subset.comparator([{ field: "b", direction: "asc" }])).map((r) => r.id)
    ).toEqual(["f", "t", "z"]);
    expect(
      mixed.toSorted(Subset.comparator([{ field: "n", direction: "desc" }])).map((r) => r.id)
    ).toEqual(["z", "t", "f"]);
  });

  it("breaks ties by id in code-point order", () => {
    const tied: ReadonlyArray<Subset.Row> = [
      { id: "😀", value: {} },
      { id: "￿", value: {} },
      { id: "a", value: {} },
    ];
    expect(tied.toSorted(Subset.comparator([])).map((r) => r.id)).toEqual(["a", "￿", "😀"]);
  });
});
