/**
 * RowDispatch
 *
 * The engine's tag dispatches that stay `switch` statements because a `Match`
 * measured slower where they run. Each runs per row, or per emission and
 * group, on a hot path. This module is private: `Aggregate`, `Incremental`
 * and `Predicate` call into it, and its functions keep their public names
 * there. `effect/prefer-match-over-switch` is off for this module alone, in
 * the root `vite.config.ts`, which records the measurements.
 */

import * as Arr from "effect/Array";
import type { Aggregate, AggregateValue } from "../Aggregate.js";
import type { Delta, Row } from "../Incremental.js";
import type { Comparison } from "../Predicate.js";
import type { RowChange } from "../RowChange.js";

// ─── Aggregate ───────────────────────────────────────────────────────────────

/** One aggregate's running fold, mutated in place by {@link addNumber} / {@link removeNumber}. */
export type Bucket =
  | { readonly _tag: "Count"; count: number }
  | { readonly _tag: "Sum"; sum: number }
  | { readonly _tag: "Avg"; sum: number; count: number }
  | {
      readonly _tag: "MinMax";
      readonly pick: (a: number, b: number) => number;
      current: number | undefined;
    };

/** A bucket that folds a numeric field (every bucket but `Count`'s). */
export type NumericBucket = Exclude<Bucket, { readonly _tag: "Count" }>;

/**
 * Fold the numeric values of a non-`Count` aggregate to its value. Runs once
 * per `compute`, after the page's values are collected.
 */
export const foldNumeric = (
  agg: Exclude<Aggregate, { _tag: "Count" }>,
  values: ReadonlyArray<number>
): AggregateValue => {
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
 * A fresh, empty bucket for `agg`. Runs once per incremental state: when a
 * live aggregate is built or rebuilt, and when a grouped put opens a group.
 */
export const emptyBucket = (agg: Aggregate): Bucket => {
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

/** A bucket's current value. Runs per emission, once per group of a grouped aggregate. */
export const bucketValue = (bucket: Bucket): AggregateValue => {
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

/** Fold a row's numeric field value `n` into `bucket`: per row, on every insert and update. */
export const addNumber = (bucket: NumericBucket, n: number): void => {
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
 * Retract a row's numeric field value `n` from `bucket`: per row, on every
 * removal and update. `remainingValues` is called only when `Min` / `Max`
 * loses its current extremum, and returns the values still present after the
 * removal.
 */
export const removeNumber = (
  bucket: NumericBucket,
  n: number,
  remainingValues: () => ReadonlyArray<number>
): void => {
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

// ─── Incremental ─────────────────────────────────────────────────────────────

/** `Incremental.deltaFromChanges`: per row change, on every batch. */
export const deltaFromChanges = <A>(
  known: Map<string, Row<A>>,
  batch: ReadonlyArray<RowChange<Row<A>>>
): Delta<A> => {
  const added: Array<Row<A>> = [];
  const removed: Array<Row<A>> = [];
  for (const change of batch) {
    switch (change._tag) {
      case "reset":
        for (const row of known.values()) removed.push(row);
        known.clear();
        break;
      case "enter":
        added.push(change.row);
        known.set(change.row.id, change.row);
        break;
      case "update":
        removed.push(change.previous);
        added.push(change.row);
        known.set(change.row.id, change.row);
        break;
      case "exit":
        removed.push(change.previous);
        known.delete(change.id);
        break;
      case "move":
        break;
    }
  }
  return { added, removed };
};

// ─── Predicate ───────────────────────────────────────────────────────────────

/** `Predicate.holds`: per row and per `Compare` node, in `evaluate` and `CollectionIndex`. */
export const holds = (op: Comparison, ordered: number): boolean => {
  switch (op) {
    case "eq":
      return ordered === 0;
    case "ne":
      return ordered !== 0;
    case "gt":
      return ordered > 0;
    case "gte":
      return ordered >= 0;
    case "lt":
      return ordered < 0;
    case "lte":
      return ordered <= 0;
  }
};
