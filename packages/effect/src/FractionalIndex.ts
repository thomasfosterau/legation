/**
 * FractionalIndex
 *
 * Stable position keys for in-window rows (issue #112): a string that sorts
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

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const ZERO = DIGITS[0]!;

const digitValue = (char: string): number => DIGITS.indexOf(char);
const digitChar = (value: number): string => DIGITS[value]!;

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

/**
 * A key whose value lies strictly between `lo` and `hi` (each defaulting to
 * the open bound: `lo` omitted means 0, `hi` omitted means unbounded above).
 * Throws if `lo` is not strictly before `hi`.
 */
export const generateBetween = (lo?: string, hi?: string): string => {
  if (lo !== undefined && hi !== undefined && compare(lo, hi) >= 0) {
    throw new Error(
      `FractionalIndex.generateBetween: lo (${JSON.stringify(lo)}) must sort before hi (${JSON.stringify(hi)})`
    );
  }
  const digits: Array<number> = [];
  let unbounded = hi === undefined;
  for (let i = 0; ; i++) {
    const loDigit = lo !== undefined && i < lo.length ? digitValue(lo[i]!) : 0;
    const hiDigit = unbounded ? BASE : i < hi!.length ? digitValue(hi![i]!) : 0;
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
 * `count` keys, all strictly between `lo` and `hi` and strictly increasing —
 * built by recursively bisecting the interval so the keys stay close in
 * length (O(log count) longer than a single `generateBetween`) rather than
 * chaining `generateBetween(lo, hi)` calls, which would grow the last key
 * by one digit per call.
 */
export const generateNBetween = (
  lo: string | undefined,
  hi: string | undefined,
  count: number
): ReadonlyArray<string> => {
  if (count <= 0) return [];
  if (count === 1) return [generateBetween(lo, hi)];
  const mid = generateBetween(lo, hi);
  const left = Math.floor(count / 2);
  return [...generateNBetween(lo, mid, left), mid, ...generateNBetween(mid, hi, count - left - 1)];
};
