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

import { Schema, Stream } from "effect";

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

export const count: Aggregate = { _tag: "Count" };
export const sum = (field: string): Aggregate => ({ _tag: "Sum", field });
export const min = (field: string): Aggregate => ({ _tag: "Min", field });
export const max = (field: string): Aggregate => ({ _tag: "Max", field });
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
  const raw =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
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
      return values.length === 0
        ? undefined
        : values.reduce((total, value) => total + value, 0) / values.length;
    case "Min":
      return values.length === 0 ? undefined : values.reduce((a, b) => (a < b ? a : b));
    case "Max":
      return values.length === 0 ? undefined : values.reduce((a, b) => (a > b ? a : b));
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
  String(
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[groupBy]
      : undefined
  );

/**
 * Evaluate an aggregate per group, keying the result by
 * `String(row.value[groupBy])`. Each group's value follows {@link compute}.
 */
export const computeGrouped = (
  agg: Aggregate,
  rows: ReadonlyArray<{ readonly value: unknown }>,
  groupBy: string
): Record<string, AggregateValue> => {
  const buckets = new Map<string, Array<{ readonly value: unknown }>>();
  for (const row of rows) {
    const key = groupKey(row.value, groupBy);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  const result: Record<string, AggregateValue> = {};
  for (const [key, bucket] of buckets) result[key] = compute(agg, bucket);
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
