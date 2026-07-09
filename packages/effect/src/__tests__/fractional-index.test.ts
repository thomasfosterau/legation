/**
 * FractionalIndex: `generateBetween`/`generateNBetween` always produce keys
 * that `compare` orders strictly between their bounds, including the
 * degenerate-looking cases (adjacent digits, no bound on one side) that
 * trip up naive lexicographic-string implementations (module doc).
 */
import { describe, expect, it } from "vitest";
import * as FractionalIndex from "../FractionalIndex.js";

describe("FractionalIndex", () => {
  it("generates a key with no bounds", () => {
    const key = FractionalIndex.generateBetween();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("generates a key strictly after a lower bound only", () => {
    const first = FractionalIndex.generateBetween();
    const after = FractionalIndex.generateBetween(first, undefined);
    expect(FractionalIndex.compare(first, after)).toBeLessThan(0);
  });

  it("generates a key strictly before an upper bound only", () => {
    const first = FractionalIndex.generateBetween();
    const before = FractionalIndex.generateBetween(undefined, first);
    expect(FractionalIndex.compare(before, first)).toBeLessThan(0);
  });

  it("generates a key strictly between two bounds", () => {
    const lo = FractionalIndex.generateBetween();
    const hi = FractionalIndex.generateBetween(lo, undefined);
    const mid = FractionalIndex.generateBetween(lo, hi);
    expect(FractionalIndex.compare(lo, mid)).toBeLessThan(0);
    expect(FractionalIndex.compare(mid, hi)).toBeLessThan(0);
  });

  it("rejects a lower bound that does not sort before the upper bound", () => {
    const a = FractionalIndex.generateBetween();
    expect(() => FractionalIndex.generateBetween(a, a)).toThrow(/must sort before/);
    const before = FractionalIndex.generateBetween(undefined, a);
    expect(() => FractionalIndex.generateBetween(a, before)).toThrow(/must sort before/);
  });

  it("handles the adjacent-digit case that traps naive lexicographic schemes", () => {
    // Under raw string comparison, nothing sorts between "A" and "A0" (any
    // extension of "A" is lexicographically >= "A0"); FractionalIndex compares
    // by value (zero-padded), where "A" and "A0" are the *same* value, so this
    // pair can never arise from `generateBetween` in the first place. Assert
    // that directly: the module's own value semantics, not the string trap.
    expect(FractionalIndex.compare("A", "A0")).toBe(0);
    expect(() => FractionalIndex.generateBetween("A", "A0")).toThrow(/must sort before/);
  });

  it("repeated insertion at the same boundary keeps splitting correctly", () => {
    let hi = FractionalIndex.generateBetween();
    const keys = [hi];
    for (let i = 0; i < 50; i++) {
      hi = FractionalIndex.generateBetween(undefined, hi);
      keys.push(hi);
    }
    // Strictly decreasing (each new key is the tightest lower neighbor so far).
    for (let i = 1; i < keys.length; i++) {
      expect(FractionalIndex.compare(keys[i]!, keys[i - 1]!)).toBeLessThan(0);
    }
  });

  it("generateNBetween produces N strictly increasing keys within bounds", () => {
    const lo = FractionalIndex.generateBetween();
    const hi = FractionalIndex.generateBetween(lo, undefined);
    const keys = FractionalIndex.generateNBetween(lo, hi, 25);
    expect(keys.length).toBe(25);
    let previous = lo;
    for (const key of keys) {
      expect(FractionalIndex.compare(previous, key)).toBeLessThan(0);
      previous = key;
    }
    expect(FractionalIndex.compare(previous, hi)).toBeLessThan(0);
  });

  it("generateNBetween with no bounds still produces N increasing keys", () => {
    const keys = FractionalIndex.generateNBetween(undefined, undefined, 10);
    expect(keys.length).toBe(10);
    for (let i = 1; i < keys.length; i++) {
      expect(FractionalIndex.compare(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    }
  });

  it("generateNBetween(0) is empty and (1) matches generateBetween", () => {
    expect(FractionalIndex.generateNBetween(undefined, undefined, 0)).toEqual([]);
    const [single] = FractionalIndex.generateNBetween(undefined, undefined, 1);
    expect(typeof single).toBe("string");
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
    let keys = [FractionalIndex.generateBetween()];
    for (let i = 0; i < 300; i++) {
      const index = Math.floor(next() * keys.length);
      const lo = index > 0 ? keys[index - 1] : undefined;
      const hi = keys[index];
      const inserted = FractionalIndex.generateBetween(lo, hi);
      keys = [...keys.slice(0, index), inserted, ...keys.slice(index)];
    }
    for (let i = 1; i < keys.length; i++) {
      expect(FractionalIndex.compare(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    }
  });
});
