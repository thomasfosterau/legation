/**
 * Aggregate
 *
 * Serialisable aggregate descriptors over a subset's rows — count, sum, min,
 * max, average. Like {@link Predicate}, an aggregate is *data* (a tagged
 * value plus an Effect `Schema`), not an opaque function, so it can travel
 * over the wire: the local tier evaluates it in memory here, and a future
 * server-evaluated tier can carry the same descriptor unchanged.
 *
 * Evaluation is pure over already-filtered, already-sorted `(id, value)` rows
 * (the shape a subset produces): the engine hands `Subset.apply`'s result to
 * {@link compute} / {@link computeGrouped}.
 */

import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Predicate from "./Predicate.js";

/**
 * An aggregate descriptor.
 *
 * - `Count` counts the rows (no field).
 * - `Sum` / `Min` / `Max` / `Avg` fold a numeric row field; non-numeric field
 *   values are skipped (see {@link AggregateValue} for the empty/absent
 *   behaviour of each).
 */
export type Aggregate =
  | { readonly _tag: "Count" }
  | { readonly _tag: "Sum" | "Min" | "Max" | "Avg"; readonly field: string };

/** Wire codec for {@link Aggregate} — a union of tagged structs (mirrors `PredicateSchema`). */
export const AggregateSchema: Schema.Codec<Aggregate> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Count") }),
  Schema.Struct({
    _tag: Schema.Literals(["Sum", "Min", "Max", "Avg"]),
    field: Schema.String,
  }),
]) as Schema.Codec<Aggregate>;

// ─── Constructors ────────────────────────────────────────────────────────────

/** Count the rows. */
export const count: Aggregate = { _tag: "Count" };
/** Sum a numeric field; non-numeric values are skipped. */
export const sum = (field: string): Aggregate => ({ _tag: "Sum", field });
/** The smallest value of a numeric field; non-numeric values are skipped. */
export const min = (field: string): Aggregate => ({ _tag: "Min", field });
/** The largest value of a numeric field; non-numeric values are skipped. */
export const max = (field: string): Aggregate => ({ _tag: "Max", field });
/** The mean of a numeric field; non-numeric values are skipped. */
export const avg = (field: string): Aggregate => ({ _tag: "Avg", field });

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * An aggregate's value.
 *
 * - `Count` → the row count (`number`).
 * - `Sum` → the sum of numeric values; the empty (or all-non-numeric) sum is
 *   `0`.
 * - `Avg` → the mean of numeric values, or `undefined` when there are none.
 * - `Min` / `Max` → the least/greatest numeric value, or `undefined` when there
 *   are none.
 */
export type AggregateValue = number | undefined;

/** A row's field as a finite number, or `undefined` if absent/non-numeric. */
const numericField = (value: unknown, field: string): number | undefined => {
  const raw = Predicate.fieldValue(value, field);
  return P.isNumber(raw) && Number.isFinite(raw) ? raw : undefined;
};

/** The numeric values of `field` across `rows`, skipping absent/non-numeric ones. */
const numericValues = (
  rows: ReadonlyArray<{ readonly value: unknown }>,
  field: string
): ReadonlyArray<number> => {
  const values: Array<number> = [];
  for (const row of rows) {
    const value = numericField(row.value, field);
    if (value !== undefined) values.push(value);
  }
  return values;
};

/** Fold the numeric values of a non-`Count` aggregate to its value. */
const foldNumeric = (agg: Exclude<Aggregate, { _tag: "Count" }>, values: ReadonlyArray<number>) => {
  switch (agg._tag) {
    case "Sum":
      return values.reduce((total, value) => total + value, 0);
    case "Avg":
      return Arr.isReadonlyArrayEmpty(values)
        ? undefined
        : values.reduce((total, value) => total + value, 0) / values.length;
    case "Min":
      return Arr.isReadonlyArrayEmpty(values)
        ? undefined
        : values.reduce((a, b) => (a < b ? a : b));
    case "Max":
      return Arr.isReadonlyArrayEmpty(values)
        ? undefined
        : values.reduce((a, b) => (a > b ? a : b));
  }
};

/**
 * Evaluate an aggregate over already-filtered/sorted rows (a subset's result).
 * Pure and total; see {@link AggregateValue} for the empty/absent semantics.
 */
export const compute = (
  agg: Aggregate,
  rows: ReadonlyArray<{ readonly value: unknown }>
): AggregateValue =>
  agg._tag === "Count" ? rows.length : foldNumeric(agg, numericValues(rows, agg.field));

/** A row's group key: `String(row.value[groupBy])` (so `undefined` → `"undefined"`). */
const groupKey = (value: unknown, groupBy: string): string =>
  String(Predicate.fieldValue(value, groupBy));

/** Partition `rows` by {@link groupKey}, preserving each group's row order. */
const bucketByGroup = <R extends { readonly value: unknown }>(
  rows: ReadonlyArray<R>,
  groupBy: string
): Map<string, Array<R>> => {
  const buckets = new Map<string, Array<R>>();
  for (const row of rows) {
    const key = groupKey(row.value, groupBy);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  return buckets;
};

/**
 * Evaluate an aggregate per group, keying the result by
 * `String(row.value[groupBy])`. Each group's value follows {@link compute}.
 */
export const computeGrouped = (
  agg: Aggregate,
  rows: ReadonlyArray<{ readonly value: unknown }>,
  groupBy: string
): Record<string, AggregateValue> => {
  const result: Record<string, AggregateValue> = {};
  for (const [key, bucket] of bucketByGroup(rows, groupBy)) result[key] = compute(agg, bucket);
  return result;
};

/** Value equality for a scalar aggregate (`Object.is`, so `NaN` is stable). */
export const sameValue = (a: AggregateValue, b: AggregateValue): boolean => Object.is(a, b);

/** Structural equality for a grouped aggregate: same keys, same values. */
export const sameGroupedValue = (
  a: Record<string, AggregateValue>,
  b: Record<string, AggregateValue>
): boolean => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
  );
};

// ─── Incremental maintenance ───────────────────────────────────────────────
//
// `compute`/`computeGrouped` fold a full page; when a live subset's rows are
// known to change by row-level delta (a `Patch`'s put/del ops — `ClientEngine`
// feeds these directly, not pre-filtered), the fold can be *maintained*
// instead of re-run every emission. `Count`/`Sum`/`Avg` update in O(1) per
// delta (subtract on removal, add on insertion, both on an update).
// `Min`/`Max` update in O(1) except when the row removed or updated away held
// the current extremum, in which case the surviving values are refolded — the
// same "scan the bag" approach `@tanstack/db-ivm` uses, since retracting a
// min/max isn't subtractable in general.
//
// A delta's row is tested against `where` here (mirrors `LiveView.put`'s
// match/no-longer-match handling), so the caller can feed raw put/del ops
// without pre-filtering: a `Put` whose value now fails `where` is folded as a
// removal, one that now passes is folded as an insertion (or update, if the
// row was already present).
//
// This state is internal and mutated in place by `applyPut`/`applyDel` for
// true O(1) amortized cost — callers (`ClientEngine`) own one `State` per live
// subscription behind a `Ref`, so there is exactly one owner at a time and no
// aliasing concern.

/** A non-`Count` aggregate's field, or `undefined` for `Count` (no field). */
const fieldOf = (agg: Aggregate): string | undefined =>
  agg._tag === "Count" ? undefined : agg.field;

/** One aggregate's running fold — mutated in place by `addToBucket`/`removeFromBucket`. */
type Bucket =
  | { readonly _tag: "Count"; count: number }
  | { readonly _tag: "Sum"; sum: number }
  | { readonly _tag: "Avg"; sum: number; count: number }
  | {
      readonly _tag: "MinMax";
      readonly pick: (a: number, b: number) => number;
      current: number | undefined;
    };

const emptyBucket = (agg: Aggregate): Bucket => {
  switch (agg._tag) {
    case "Count":
      return { _tag: "Count", count: 0 };
    case "Sum":
      return { _tag: "Sum", sum: 0 };
    case "Avg":
      return { _tag: "Avg", sum: 0, count: 0 };
    case "Min":
      return { _tag: "MinMax", pick: (a, b) => (a < b ? a : b), current: undefined };
    case "Max":
      return { _tag: "MinMax", pick: (a, b) => (a > b ? a : b), current: undefined };
  }
};

const bucketValue = (bucket: Bucket): AggregateValue => {
  switch (bucket._tag) {
    case "Count":
      return bucket.count;
    case "Sum":
      return bucket.sum;
    case "Avg":
      return bucket.count === 0 ? undefined : bucket.sum / bucket.count;
    case "MinMax":
      return bucket.current;
  }
};

/** Fold one row's value into `bucket` (an insertion, or an update's "add" half). */
const addToBucket = (bucket: Bucket, value: unknown, field: string | undefined): void => {
  if (bucket._tag === "Count") {
    bucket.count += 1;
    return;
  }
  // Only `Count` has no field, and it returned above.
  if (field === undefined) return;
  const n = numericField(value, field);
  if (n === undefined) return;
  switch (bucket._tag) {
    case "Sum":
      bucket.sum += n;
      return;
    case "Avg":
      bucket.sum += n;
      bucket.count += 1;
      return;
    case "MinMax":
      bucket.current = bucket.current === undefined ? n : bucket.pick(bucket.current, n);
      return;
  }
};

/**
 * Retract one row's value from `bucket` (a removal, or an update's "remove"
 * half). `remainingValues` is called only when `Min`/`Max` loses its current
 * extremum — it must return the numeric values still present *after* this
 * row's removal, so the refold is O(the surviving bag), not O(1) but never
 * more than the group it belongs to.
 */
const removeFromBucket = (
  bucket: Bucket,
  value: unknown,
  field: string | undefined,
  remainingValues: () => ReadonlyArray<number>
): void => {
  if (bucket._tag === "Count") {
    bucket.count -= 1;
    return;
  }
  // Only `Count` has no field, and it returned above.
  if (field === undefined) return;
  const n = numericField(value, field);
  if (n === undefined) return;
  switch (bucket._tag) {
    case "Sum":
      bucket.sum -= n;
      return;
    case "Avg":
      bucket.sum -= n;
      bucket.count -= 1;
      return;
    case "MinMax": {
      if (n !== bucket.current) return; // not the extremum: O(1), no refold needed
      const rest = remainingValues();
      bucket.current = Arr.isReadonlyArrayEmpty(rest) ? undefined : rest.reduce(bucket.pick);
      return;
    }
  }
};

/** The numeric values of `byId`'s field, skipping absent/non-numeric ones. */
const numericValuesOf = (
  byId: ReadonlyMap<string, unknown>,
  field: string
): ReadonlyArray<number> => {
  const values: Array<number> = [];
  for (const value of byId.values()) {
    const n = numericField(value, field);
    if (n !== undefined) values.push(n);
  }
  return values;
};

/** A `(id, value)` row — the unit incremental maintenance operates over. */
export interface Row {
  readonly id: string;
  readonly value: unknown;
}

/**
 * Incremental state for one (ungrouped) aggregate: `byId` mirrors the rows
 * currently matching `where` (needed to tell an insert from an update from a
 * no-longer-matching removal), `bucket` is the running fold.
 */
export interface State {
  readonly byId: Map<string, unknown>;
  readonly bucket: Bucket;
}

/** Build state from already-filtered rows (mirrors {@link compute}'s input) — the Rebuild/subscribe-time path. */
export const initState = (agg: Aggregate, rows: ReadonlyArray<Row>): State => {
  const field = fieldOf(agg);
  const byId = new Map<string, unknown>();
  const bucket = emptyBucket(agg);
  for (const row of rows) {
    byId.set(row.id, row.value);
    addToBucket(bucket, row.value, field);
  }
  return { byId, bucket };
};

/**
 * Apply a row upsert against `where`: folds as an insertion, an update, a
 * removal (row matched before but not now), or a no-op (never matched),
 * exactly mirroring {@link LiveView.put}'s match/no-longer-match handling.
 * Mutates and returns `state`.
 */
export const applyPut = (
  state: State,
  agg: Aggregate,
  where: Predicate.Predicate,
  id: string,
  value: unknown
): State => {
  const field = fieldOf(agg);
  const existing = state.byId.get(id);
  const matches = Predicate.test(where, value);
  if (existing === undefined && !matches) return state;
  if (existing !== undefined) {
    state.byId.delete(id);
    removeFromBucket(state.bucket, existing, field, () =>
      field === undefined ? [] : numericValuesOf(state.byId, field)
    );
  }
  if (matches) {
    state.byId.set(id, value);
    addToBucket(state.bucket, value, field);
  }
  return state;
};

/** Apply a row deletion. A no-op if `id` never matched. Mutates and returns `state`. */
export const applyDel = (state: State, agg: Aggregate, id: string): State => {
  const existing = state.byId.get(id);
  if (existing === undefined) return state;
  const field = fieldOf(agg);
  state.byId.delete(id);
  removeFromBucket(state.bucket, existing, field, () =>
    field === undefined ? [] : numericValuesOf(state.byId, field)
  );
  return state;
};

/** The current value of an incrementally-maintained (ungrouped) aggregate. */
export const stateValue = (state: State): AggregateValue => bucketValue(state.bucket);

/**
 * Incremental state for a grouped aggregate: `groupKeyOf` tracks each
 * currently-matching row's group key (so a moved row's old group can be
 * found), `groups` holds one {@link State} per key present.
 */
export interface GroupedState {
  readonly groupKeyOf: Map<string, string>;
  readonly groups: Map<string, State>;
}

/** Build grouped state from already-filtered rows (mirrors {@link computeGrouped}'s input). */
export const initGroupedState = (
  agg: Aggregate,
  rows: ReadonlyArray<Row>,
  groupBy: string
): GroupedState => {
  const groups = new Map<string, State>();
  const groupKeyOf = new Map<string, string>();
  for (const [key, bucketRows] of bucketByGroup(rows, groupBy)) {
    groups.set(key, initState(agg, bucketRows));
    for (const row of bucketRows) groupKeyOf.set(row.id, key);
  }
  return { groupKeyOf, groups };
};

/**
 * Apply a row upsert against `where`/`groupBy`: touches only the row's old
 * group (if it moved or left) and new group (if it now matches) — every
 * other group's {@link State} is untouched, so its value is unchanged by
 * reference as well as by value. A group whose last row leaves is dropped, so
 * the emitted record never carries an empty key (matching
 * {@link computeGrouped}). Mutates and returns `state`.
 */
export const applyGroupedPut = (
  state: GroupedState,
  agg: Aggregate,
  where: Predicate.Predicate,
  groupBy: string,
  id: string,
  value: unknown
): GroupedState => {
  const matches = Predicate.test(where, value);
  const existingKey = state.groupKeyOf.get(id);
  const newKey = matches ? groupKey(value, groupBy) : undefined;
  if (existingKey === undefined && newKey === undefined) return state;

  if (existingKey !== undefined && existingKey !== newKey) {
    const oldGroup = state.groups.get(existingKey);
    if (oldGroup !== undefined) {
      applyDel(oldGroup, agg, id);
      if (oldGroup.byId.size === 0) state.groups.delete(existingKey);
    }
  }

  if (newKey === undefined) {
    state.groupKeyOf.delete(id);
    return state;
  }

  let newGroup = state.groups.get(newKey);
  if (newGroup === undefined) {
    newGroup = initState(agg, []);
    state.groups.set(newKey, newGroup);
  }
  applyPut(newGroup, agg, where, id, value);
  state.groupKeyOf.set(id, newKey);
  return state;
};

/** Apply a row deletion. A no-op if `id` never matched. Mutates and returns `state`. */
export const applyGroupedDel = (state: GroupedState, agg: Aggregate, id: string): GroupedState => {
  const existingKey = state.groupKeyOf.get(id);
  if (existingKey === undefined) return state;
  const group = state.groups.get(existingKey);
  if (group !== undefined) {
    applyDel(group, agg, id);
    if (group.byId.size === 0) state.groups.delete(existingKey);
  }
  state.groupKeyOf.delete(id);
  return state;
};

/** The current value of an incrementally-maintained grouped aggregate. */
export const groupedStateValue = (state: GroupedState): Record<string, AggregateValue> => {
  const result: Record<string, AggregateValue> = {};
  for (const [key, group] of state.groups) result[key] = bucketValue(group.bucket);
  return result;
};

/**
 * Live aggregate over a stream of row pages (any {@link ClientView.observe}
 * source — engine or mirror): {@link compute} per emission, deduped so the
 * stream re-emits only when the value actually changes.
 */
export const observe = <E>(
  rows: Stream.Stream<ReadonlyArray<{ readonly value: unknown }>, E>,
  agg: Aggregate
): Stream.Stream<AggregateValue, E> =>
  rows.pipe(
    Stream.map((page) => compute(agg, page)),
    Stream.changesWith(sameValue)
  );

/** Live grouped aggregate over a stream of row pages; see {@link observe}. */
export const observeGrouped = <E>(
  rows: Stream.Stream<ReadonlyArray<{ readonly value: unknown }>, E>,
  agg: Aggregate,
  groupBy: string
): Stream.Stream<Record<string, AggregateValue>, E> =>
  rows.pipe(
    Stream.map((page) => computeGrouped(agg, page, groupBy)),
    Stream.changesWith(sameGroupedValue)
  );
