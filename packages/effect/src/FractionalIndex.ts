/**
 * FractionalIndex
 *
 * Stable position keys for in-window rows: a string that sorts
 * between any two others, so a row entering, leaving, or moving within a
 * maintained window can be given a key without renumbering its neighbors —
 * the primitive behind expressing a delta as `{ type: "move", key, position
 * }` instead of diffing pages (a future row-level delta feed's concern;
 * `LiveView` only assigns and maintains the keys today).
 *
 * Each key is a base-62 digit string (`0-9A-Za-z`, chosen so ASCII order
 * already matches digit order) read as a fraction in `[0, 1)`:
 * `digits[0] * 62⁻¹ + digits[1] * 62⁻² + …`. Keys compare by that *value*,
 * not raw string order — `compare` zero-pads the shorter key first, so e.g.
 * `"5"` and `"50"` (both 5/62) compare equal. This is what keeps
 * `generateBetween` total: two real numbers always have a value strictly
 * between them, so — unlike schemes that compare the raw strings
 * lexicographically (where, say, nothing sorts between `"A"` and `"A0"`,
 * since any extension of `"A"` is lexicographically ≥ `"A0"`) — there is no
 * pair of distinct keys this can fail to split.
 *
 * Repeatedly inserting at the same boundary (e.g. always "before the
 * current first row") grows key length by roughly one digit every ~5-6
 * insertions at that boundary (`log_2(62)`) — the standard, accepted cost of
 * any fractional-indexing scheme (TanStack DB's `generateKeyBetween`,
 * Figma's original algorithm) and not specific to this implementation.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Json from "./internal/Json.js";

/** The failure of `generateBetween` and `generateNBetween` when `lo` does not sort before `hi`. */
export class InvalidBounds extends Schema.TaggedError<
  InvalidBounds,
  { readonly brand: unique symbol }
>()("InvalidBounds", { message: Schema.String }) {}

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const ZERO = DIGITS.charAt(0);

const digitValue = (char: string): number => DIGITS.indexOf(char);
const digitChar = (value: number): string => DIGITS.charAt(value);

/** The digit of `key` at position `i`; a position past its end reads as 0. */
const digitAt = (key: string, i: number): number =>
  i < key.length ? digitValue(key.charAt(i)) : 0;

/**
 * Compare two keys by the fraction they encode (zero-padding the shorter
 * one), not by raw string order — see the module doc for why that matters.
 */
export const compare = (a: string, b: string): number => {
  const length = Math.max(a.length, b.length);
  const pa = a.padEnd(length, ZERO);
  const pb = b.padEnd(length, ZERO);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
};

/** `lo` and `hi` when `lo` sorts strictly before `hi` (an omitted bound is open). */
const checkBounds = (
  operation: string,
  lo?: string,
  hi?: string
): Result.Result<void, InvalidBounds> =>
  lo !== undefined && hi !== undefined && compare(lo, hi) >= 0
    ? Result.fail(
        new InvalidBounds({
          message: `FractionalIndex.${operation}: lo (${Json.stringify(lo)}) must sort before hi (${Json.stringify(hi)})`,
        })
      )
    : Result.void;

/** The key midway between bounds already known to be ordered. */
const between = (lo?: string, hi?: string): string => {
  const digits: Array<number> = [];
  let unbounded = hi === undefined;
  for (let i = 0; ; i++) {
    const loDigit = lo === undefined ? 0 : digitAt(lo, i);
    const hiDigit = unbounded || hi === undefined ? BASE : digitAt(hi, i);
    const gap = hiDigit - loDigit;
    if (gap >= 2) {
      digits.push(loDigit + Math.floor(gap / 2));
      return digits.map(digitChar).join("");
    }
    digits.push(loDigit);
    if (gap === 1) unbounded = true; // this digit already sorts below hi; no bound below it
  }
};

/**
 * A key whose value lies strictly between `lo` and `hi` (each defaulting to
 * the open bound: `lo` omitted means 0, `hi` omitted means unbounded above).
 * Fails with {@link InvalidBounds} if `lo` is not strictly before `hi`.
 */
export const generateBetween = (lo?: string, hi?: string): Result.Result<string, InvalidBounds> =>
  Result.map(checkBounds("generateBetween", lo, hi), () => between(lo, hi));

/** {@link generateNBetween} over bounds already known to be ordered. */
const nBetween = (count: number, lo?: string, hi?: string): ReadonlyArray<string> => {
  if (count <= 0) return [];
  const mid = between(lo, hi);
  if (count === 1) return [mid];
  const left = Math.floor(count / 2);
  return [...nBetween(left, lo, mid), mid, ...nBetween(count - left - 1, mid, hi)];
};

/**
 * `count` keys, all strictly between `lo` and `hi` and strictly increasing —
 * built by recursively bisecting the interval so the keys stay close in
 * length (O(log count) longer than a single `generateBetween`) rather than
 * chaining `generateBetween(lo, hi)` calls, which would grow the last key
 * by one digit per call. Fails with {@link InvalidBounds} if `lo` is not
 * strictly before `hi`; the bounds are checked once, since every bisection
 * stays inside them.
 */
export const generateNBetween = (
  lo: string | undefined,
  hi: string | undefined,
  count: number
): Result.Result<ReadonlyArray<string>, InvalidBounds> =>
  Result.map(checkBounds("generateNBetween", lo, hi), () => nBetween(count, lo, hi));
