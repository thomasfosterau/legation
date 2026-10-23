/**
 * CollectionIndex
 *
 * Secondary field-value indexes over a collection's confirmed rows (issue
 * #113): a hash index answers `eq`/`In`/`IsNull` and an ordered index answers
 * range `Compare`s, so a subset's `where` resolves against `O(hits)`
 * candidates instead of a full collection scan. Purely in-memory
 * acceleration — never the source of truth (the confirmed rows in
 * `ClientStore` are) — rebuilt from a full snapshot (`rebuild`) or maintained
 * incrementally from the same row deltas the engine's change hub already
 * carries (`upsertRow`/`deleteRow`/`clear`).
 *
 * `evaluate` is the planner in front of `Subset.apply`'s full-scan filter: it
 * decomposes a predicate's top-level `And` conjuncts, narrows via the index
 * for every indexable one (`eq`/`In` on a hash-indexed field, `IsNull`, range
 * `Compare`s on an ordered one), intersects the hits, and runs the residual
 * (non-indexable) conjuncts through `Predicate.test` over just those
 * candidates. A predicate with no indexable conjunct returns `undefined` —
 * the caller's cue to fall back to the full scan.
 *
 * Semantics match `Predicate.evaluate` exactly (ADR-0028), which is what the
 * property test proves over the differential corpus: NULL and absent rows
 * share one bucket (rule (b)) that no `eq`/`In`/range lookup ever returns —
 * every such comparison is unknown on a NULL field, and unknown never
 * matches — and that `IsNull` reads directly; a `Compare` with a `null`
 * literal narrows to the empty set (unknown for every row); range lookups
 * consult only same-typed rows (a number index for a number literal, a string
 * index for a string literal, the two boolean buckets for a boolean literal),
 * mirroring rule (d)'s unknown on a type mismatch; sorted runs order text by
 * code point (rule (c)). `ne`, `NotIn` and `IS NOT NULL` do not narrow — each
 * is the complement of a bucket plus three-valued handling — so they stay
 * residual conjuncts, evaluated by `Predicate.test` over the candidates.
 */

import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import type { RowId } from "./Collection.js";
import * as Predicate from "./Predicate.js";

/** One sorted entry in a range index: value plus the row id it belongs to. */
interface SortedEntry {
  readonly value: number | string;
  readonly id: RowId;
}

/** A single indexed field: hash buckets plus type-partitioned sorted runs for range queries. */
interface FieldIndex {
  readonly field: string;
  /** Exact non-null value → row ids. */
  readonly byValue: Map<unknown, Set<RowId>>;
  /** Rows whose field is NULL or absent — one bucket, per ADR-0028 rule (b). */
  readonly nulls: Set<RowId>;
  /** Rows whose value is a `number`, sorted ascending (value, then id). */
  readonly numbers: Array<SortedEntry>;
  /** Rows whose value is a `string`, sorted ascending by code point (value, then id). */
  readonly strings: Array<SortedEntry>;
  /** Each indexed row's last-seen raw field value, so an update/delete finds its old bucket. */
  readonly current: Map<RowId, unknown>;
}

/** A collection's secondary index: one {@link FieldIndex} per declared/auto-discovered field. */
export interface CollectionIndex {
  readonly fields: ReadonlyMap<string, FieldIndex>;
}

const EMPTY_IDS: ReadonlySet<RowId> = new Set();

const emptyField = (field: string): FieldIndex => ({
  field,
  byValue: new Map(),
  nulls: new Set(),
  numbers: [],
  strings: [],
  current: new Map(),
});

/** Build an empty index over the given field names. */
export const empty = (fields: Iterable<string>): CollectionIndex => ({
  fields: new Map([...fields].map((field) => [field, emptyField(field)])),
});

/** The field names this index covers. */
export const fieldNames = (index: CollectionIndex): ReadonlySet<string> =>
  new Set(index.fields.keys());

// ─── Ordered maintenance (binary search insert/remove/range) ────────────────

/** Order two sorted-run values; each run holds one type, so `compareLiterals` always answers. */
const valueOrder = (a: number | string, b: number | string): number =>
  Predicate.compareLiterals(a, b) ?? 0;

const entryOrder = (a: SortedEntry, b: SortedEntry): number => {
  const byValue = valueOrder(a.value, b.value);
  return byValue !== 0 ? byValue : Predicate.compareText(a.id, b.id);
};

const lowerBoundOf = (arr: ReadonlyArray<SortedEntry>, probe: SortedEntry): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = arr[mid];
    if (entry !== undefined && entryOrder(entry, probe) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const insertSorted = (arr: Array<SortedEntry>, entry: SortedEntry): void => {
  arr.splice(lowerBoundOf(arr, entry), 0, entry);
};

const removeSorted = (arr: Array<SortedEntry>, entry: SortedEntry): void => {
  const at = lowerBoundOf(arr, entry);
  const found = arr[at];
  if (found !== undefined && found.value === entry.value && found.id === entry.id) {
    arr.splice(at, 1);
  }
};

/** First index whose value is `>= value` (or `> value` when `strict`). */
const lowerBoundValue = (
  arr: ReadonlyArray<SortedEntry>,
  value: number | string,
  strict: boolean
): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = arr[mid];
    const ordered = entry === undefined ? 1 : valueOrder(entry.value, value);
    if (strict ? ordered <= 0 : ordered < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const rangeIds = (
  arr: ReadonlyArray<SortedEntry>,
  op: Predicate.Comparison,
  value: number | string
): ReadonlySet<RowId> => {
  let start = 0;
  let end = arr.length;
  switch (op) {
    case "gt":
      start = lowerBoundValue(arr, value, true);
      break;
    case "gte":
      start = lowerBoundValue(arr, value, false);
      break;
    case "lt":
      end = lowerBoundValue(arr, value, false);
      break;
    case "lte":
      end = lowerBoundValue(arr, value, true);
      break;
    default:
      return EMPTY_IDS;
  }
  const ids = new Set<RowId>();
  for (let i = start; i < end; i++) {
    const entry = arr[i];
    if (entry !== undefined) ids.add(entry.id);
  }
  return ids;
};

// ─── Field-index maintenance ─────────────────────────────────────────────────

const unindexField = (fi: FieldIndex, id: RowId): void => {
  if (!fi.current.has(id)) return;
  const old = fi.current.get(id);
  if (Predicate.isNullish(old)) {
    fi.nulls.delete(id);
  } else {
    const bucket = fi.byValue.get(old);
    if (bucket !== undefined) {
      bucket.delete(id);
      if (bucket.size === 0) fi.byValue.delete(old);
    }
    if (P.isNumber(old)) removeSorted(fi.numbers, { value: old, id });
    else if (P.isString(old)) removeSorted(fi.strings, { value: old, id });
  }
  fi.current.delete(id);
};

const indexField = (fi: FieldIndex, id: RowId, rowValue: unknown): void => {
  unindexField(fi, id);
  const raw = Predicate.fieldValue(rowValue, fi.field);
  fi.current.set(id, raw);
  if (Predicate.isNullish(raw)) {
    fi.nulls.add(id);
    return;
  }
  const bucket = fi.byValue.get(raw);
  if (bucket === undefined) fi.byValue.set(raw, new Set([id]));
  else bucket.add(id);
  if (P.isNumber(raw)) insertSorted(fi.numbers, { value: raw, id });
  else if (P.isString(raw)) insertSorted(fi.strings, { value: raw, id });
};

const clearField = (fi: FieldIndex): void => {
  fi.byValue.clear();
  fi.nulls.clear();
  fi.numbers.length = 0;
  fi.strings.length = 0;
  fi.current.clear();
};

// ─── Collection-level maintenance ────────────────────────────────────────────

/** Index (or re-index) one row across every field this index covers. */
export const upsertRow = (index: CollectionIndex, id: RowId, value: unknown): void => {
  for (const fi of index.fields.values()) indexField(fi, id, value);
};

/** Remove one row from every field this index covers. */
export const deleteRow = (index: CollectionIndex, id: RowId): void => {
  for (const fi of index.fields.values()) unindexField(fi, id);
};

/** Drop every indexed row (a `Clear` patch op, or the prelude to {@link rebuild}). */
export const clear = (index: CollectionIndex): void => {
  for (const fi of index.fields.values()) clearField(fi);
};

/** Rebuild the index from a full row snapshot (boot, `Rebuild`, store-version bust). */
export const rebuild = (
  index: CollectionIndex,
  rows: Iterable<{ readonly id: RowId; readonly value: unknown }>
): void => {
  clear(index);
  for (const row of rows) upsertRow(index, row.id, row.value);
};

// ─── Planning ────────────────────────────────────────────────────────────────

/** A narrowed candidate set plus the predicate still to test over it. */
export interface Plan {
  readonly candidateIds: ReadonlySet<RowId>;
  readonly residual: Predicate.Predicate;
}

/** The rows holding exactly `value`; a `null` literal matches no row (unknown everywhere). */
const hashLookup = (fi: FieldIndex, value: Predicate.Literal): ReadonlySet<RowId> =>
  value === null ? EMPTY_IDS : (fi.byValue.get(value) ?? EMPTY_IDS);

const hashLookupIn = (
  fi: FieldIndex,
  values: ReadonlyArray<Predicate.Literal>
): ReadonlySet<RowId> => {
  if (Arr.isReadonlyArrayEmpty(values)) return EMPTY_IDS;
  const ids = new Set<RowId>();
  for (const value of values) for (const id of hashLookup(fi, value)) ids.add(id);
  return ids;
};

/**
 * A range `Compare` against a boolean literal, from the two boolean buckets:
 * Postgres orders `false < true` (ADR-0028 section 3), so the matching side
 * is whichever of the two values the operator admits.
 */
const booleanRangeIds = (
  fi: FieldIndex,
  op: Predicate.Comparison,
  value: boolean
): ReadonlySet<RowId> =>
  hashLookupIn(
    fi,
    [false, true].filter((candidate) =>
      Predicate.holds(op, Predicate.compareLiterals(candidate, value) ?? 0)
    )
  );

type CompareNode = Extract<Predicate.Predicate, { readonly _tag: "Compare" }>;

/** The ids a `Compare` conjunct narrows to on an indexed field, or `undefined` for `ne`. */
const compareIds = (fi: FieldIndex, conjunct: CompareNode): ReadonlySet<RowId> | undefined => {
  if (conjunct.op === "ne") return undefined; // complement of a bucket isn't narrowing
  if (conjunct.value === null) return EMPTY_IDS; // unknown for every row (ADR-0028 §5)
  if (conjunct.op === "eq") return hashLookup(fi, conjunct.value);
  if (P.isNumber(conjunct.value)) return rangeIds(fi.numbers, conjunct.op, conjunct.value);
  if (P.isString(conjunct.value)) return rangeIds(fi.strings, conjunct.op, conjunct.value);
  return booleanRangeIds(fi, conjunct.op, conjunct.value);
};

/** Apply `narrow` to the field's index when the field is indexed; `undefined` otherwise. */
const onField = (
  index: CollectionIndex,
  field: string,
  narrow: (fi: FieldIndex) => ReadonlySet<RowId> | undefined
): ReadonlySet<RowId> | undefined => {
  const fi = index.fields.get(field);
  return fi === undefined ? undefined : narrow(fi);
};

/**
 * The narrowed id set an indexable conjunct yields, or `undefined` when it
 * can't narrow. Only `Compare`, `In` and a non-negated `IsNull` narrow; every
 * other node (`NotIn`, `Not`, `Or`, …) is residual by default, which is also
 * the safe answer for any node added later.
 */
const conjunctIds = (
  index: CollectionIndex,
  conjunct: Predicate.Predicate
): ReadonlySet<RowId> | undefined => {
  switch (conjunct._tag) {
    case "Compare":
      return onField(index, conjunct.field, (fi) => compareIds(fi, conjunct));
    case "In":
      return onField(index, conjunct.field, (fi) => hashLookupIn(fi, conjunct.values));
    case "IsNull":
      // `IS NOT NULL` is the complement of a bucket: not narrowing.
      return conjunct.negated === true
        ? undefined
        : onField(index, conjunct.field, (fi) => fi.nulls);
    default:
      return undefined;
  }
};

const intersect = (sets: ReadonlyArray<ReadonlySet<RowId>>): ReadonlySet<RowId> => {
  const bySize = sets.toSorted((a, b) => a.size - b.size);
  const [smallest, ...rest] = bySize;
  if (smallest === undefined) return EMPTY_IDS;
  if (Arr.isReadonlyArrayEmpty(rest)) return smallest;
  const result = new Set<RowId>();
  for (const id of smallest) {
    if (rest.every((set) => set.has(id))) result.add(id);
  }
  return result;
};

/**
 * Plan a predicate's evaluation against this index: decompose top-level `And`
 * conjuncts, narrow every indexable one, and intersect. Returns `undefined`
 * when no conjunct narrows — the caller's cue to fall back to a full scan.
 */
export const plan = (index: CollectionIndex, predicate: Predicate.Predicate): Plan | undefined => {
  const conjuncts = predicate._tag === "And" ? predicate.predicates : [predicate];
  const narrowing: Array<ReadonlySet<RowId>> = [];
  const residual: Array<Predicate.Predicate> = [];
  for (const conjunct of conjuncts) {
    const ids = conjunctIds(index, conjunct);
    if (ids === undefined) residual.push(conjunct);
    else narrowing.push(ids);
  }
  if (Arr.isReadonlyArrayEmpty(narrowing)) return undefined;
  return {
    candidateIds: intersect(narrowing),
    residual: Arr.isReadonlyArrayEmpty(residual) ? Predicate.always : Predicate.and(...residual),
  };
};

/**
 * Evaluate a predicate against `rowsById` using the index: `undefined` when
 * the predicate has no indexable conjunct (full-scan fallback), otherwise the
 * exact rows `rowsById` values filtered by `predicate` would yield — just
 * computed from `O(hits)` candidates instead of every row.
 */
export const evaluate = <R extends { readonly id: RowId; readonly value: unknown }>(
  index: CollectionIndex,
  rowsById: ReadonlyMap<RowId, R>,
  predicate: Predicate.Predicate
): ReadonlyArray<R> | undefined => {
  const found = plan(index, predicate);
  if (found === undefined) return undefined;
  const results: Array<R> = [];
  for (const id of found.candidateIds) {
    const row = rowsById.get(id);
    if (row !== undefined && Predicate.test(found.residual, row.value)) results.push(row);
  }
  return results;
};
