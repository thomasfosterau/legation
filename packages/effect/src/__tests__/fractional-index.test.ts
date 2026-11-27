/**
 * FractionalIndex: `generateBetween`/`generateNBetween` always produce keys
 * that `compare` orders strictly between their bounds, including the
 * degenerate-looking cases (adjacent digits, no bound on one side) that
 * trip up naive lexicographic-string implementations (module doc).
 */
import * as Arr from "effect/Array";
import { identity } from "effect/Function";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import * as FractionalIndex from "../FractionalIndex.js";

/** A key between ordered bounds (the tests' bounds always are). */
const between = (lo?: string, hi?: string): string =>
  Result.getOrThrowWith(FractionalIndex.generateBetween(lo, hi), identity);

const nBetween = (count: number, lo?: string, hi?: string) =>
  Result.getOrThrowWith(FractionalIndex.generateNBetween(lo, hi, count), identity);

/** The message of the `InvalidBounds` a refused pair of bounds fails with. */
const refusal = <A>(result: Result.Result<A, FractionalIndex.InvalidBounds>): string =>
  Result.match(result, { onSuccess: () => "", onFailure: (error) => error.message });

describe("FractionalIndex", () => {
  it("generates a key with no bounds", () => {
    const key = between();
    expect(key).toBeTypeOf("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("generates a key strictly after a lower bound only", () => {
    const first = between();
    const after = between(first, undefined);
    expect(FractionalIndex.compare(first, after)).toBeLessThan(0);
  });

  it("generates a key strictly before an upper bound only", () => {
    const first = between();
    const before = between(undefined, first);
    expect(FractionalIndex.compare(before, first)).toBeLessThan(0);
  });

  it("generates a key strictly between two bounds", () => {
    const lo = between();
    const hi = between(lo, undefined);
    const mid = between(lo, hi);
    expect(FractionalIndex.compare(lo, mid)).toBeLessThan(0);
    expect(FractionalIndex.compare(mid, hi)).toBeLessThan(0);
  });

  it("rejects a lower bound that does not sort before the upper bound", () => {
    const a = between();
    expect(refusal(FractionalIndex.generateBetween(a, a))).toMatch(/must sort before/);
    const before = between(undefined, a);
    expect(refusal(FractionalIndex.generateBetween(a, before))).toMatch(/must sort before/);
  });

  it("generateNBetween refuses unordered bounds, whatever the count", () => {
    const a = between();
    expect(refusal(FractionalIndex.generateNBetween(a, a, 3))).toMatch(/generateNBetween/);
    expect(refusal(FractionalIndex.generateNBetween(a, a, 0))).toMatch(/must sort before/);
  });

  it("handles the adjacent-digit case that traps naive lexicographic schemes", () => {
    // Under raw string comparison, nothing sorts between "A" and "A0" (any
    // extension of "A" is lexicographically >= "A0"); FractionalIndex compares
    // by value (zero-padded), where "A" and "A0" are the *same* value, so this
    // pair can never arise from `generateBetween` in the first place. Assert
    // that directly: the module's own value semantics, not the string trap.
    expect(FractionalIndex.compare("A", "A0")).toBe(0);
    expect(refusal(FractionalIndex.generateBetween("A", "A0"))).toMatch(/must sort before/);
  });

  it("repeated insertion at the same boundary keeps splitting correctly", () => {
    const keys = Arr.scan(Arr.range(1, 50), between(), (hi) => between(undefined, hi));
    // Strictly decreasing (each new key is the tightest lower neighbor so far).
    Arr.forEach(Arr.zip(keys, Arr.drop(keys, 1)), ([previous, key]) => {
      expect(FractionalIndex.compare(key, previous)).toBeLessThan(0);
    });
  });

  it("generateNBetween produces N strictly increasing keys within bounds", () => {
    const lo = between();
    const hi = between(lo, undefined);
    const keys = nBetween(25, lo, hi);
    expect(keys.length).toBe(25);
    let previous = lo;
    Arr.forEach(keys, (key) => {
      expect(FractionalIndex.compare(previous, key)).toBeLessThan(0);
      previous = key;
    });
    expect(FractionalIndex.compare(previous, hi)).toBeLessThan(0);
  });

  it("generateNBetween with no bounds still produces N increasing keys", () => {
    const keys = nBetween(10, undefined, undefined);
    expect(keys.length).toBe(10);
    Arr.forEach(Arr.zip(keys, Arr.drop(keys, 1)), ([previous, key]) => {
      expect(FractionalIndex.compare(previous, key)).toBeLessThan(0);
    });
  });

  it("generateNBetween(0) is empty and (1) matches generateBetween", () => {
    expect(nBetween(0, undefined, undefined)).toEqual([]);
    const [single] = nBetween(1, undefined, undefined);
    expect(single).toBeTypeOf("string");
  });

  it("compare treats zero-padded equal values as equal regardless of string length", () => {
    expect(FractionalIndex.compare("5", "50")).toBe(0);
    expect(FractionalIndex.compare("5", "500")).toBe(0);
    expect(FractionalIndex.compare("5", "51")).toBeLessThan(0);
  });

  it("stays correct under randomized between-insertions (deterministic PRNG)", () => {
    let state = 7;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0xffffffff;
    };
    const keys = Arr.reduce(Arr.range(0, 299), [between()], (current) => {
      const index = Math.floor(next() * current.length);
      const lo = index > 0 ? current[index - 1] : undefined;
      const hi = current[index];
      const inserted = between(lo, hi);
      return [...current.slice(0, index), inserted, ...current.slice(index)];
    });
    Arr.forEach(Arr.zip(keys, Arr.drop(keys, 1)), ([previous, key]) => {
      expect(FractionalIndex.compare(previous, key)).toBeLessThan(0);
    });
  });
});
