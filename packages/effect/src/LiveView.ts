/**
 * LiveView
 *
 * A modular, incrementally-maintained materialized view: a subset's result
 * (filtered, sorted, windowed) kept current by row deltas instead of
 * re-scanning the collection. This is the caching/live-view primitive behind
 * paginated live queries — `put`/`del` place or remove a single row in O(log n)
 * and the window is sliced from the maintained order, so a change outside the
 * page never re-sorts it.
 *
 * The view holds the *full* filtered + sorted matching set so the window stays
 * correct across the limit boundary (an insert can push a row out of the page;
 * a delete can pull the next one in). It is pure data: every update returns a
 * new view (or the same reference when nothing changed), composing cleanly with
 * an `Effect` `Stream`.
 */

import * as Predicate from "./Predicate.js";
import * as Subset from "./Subset.js";

export type Row = Subset.Row;

export interface LiveView {
  readonly subset: Subset.Subset;
  /** Full filtered + sorted matching set; the window is sliced by `result`. */
  readonly rows: ReadonlyArray<Row>;
}

/** Build a view from an unordered collection snapshot. */
export const make = (subset: Subset.Subset, rows: ReadonlyArray<Row>): LiveView => ({
  subset,
  rows: Subset.sortFiltered(rows, subset),
});

/** The visible page: the subset's cursor + limit over the maintained order. */
export const result = (view: LiveView): ReadonlyArray<Row> => Subset.window(view.rows, view.subset);

const removeAt = (rows: ReadonlyArray<Row>, index: number): ReadonlyArray<Row> => [
  ...rows.slice(0, index),
  ...rows.slice(index + 1),
];

/** Insert a row at its sorted position (binary search by value comparator). */
const insertSorted = (
  rows: ReadonlyArray<Row>,
  row: Row,
  compare: (a: unknown, b: unknown) => number
): ReadonlyArray<Row> => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid]!.value, row.value) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return [...rows.slice(0, lo), row, ...rows.slice(lo)];
};

/**
 * Apply a row upsert: place it at its sorted position if it matches the
 * predicate, or remove it if it no longer does. Returns the same view reference
 * when the row neither matched before nor matches now.
 */
export const put = (view: LiveView, row: Row): LiveView => {
  const matches = Predicate.test(view.subset.where, row.value);
  const index = view.rows.findIndex((r) => r.id === row.id);
  if (!matches) return index < 0 ? view : { ...view, rows: removeAt(view.rows, index) };
  const without = index < 0 ? view.rows : removeAt(view.rows, index);
  return { ...view, rows: insertSorted(without, row, Subset.comparator(view.subset.orderBy)) };
};

/** Apply a row deletion. Returns the same view reference if the id is absent. */
export const del = (view: LiveView, id: string): LiveView => {
  const index = view.rows.findIndex((r) => r.id === id);
  return index < 0 ? view : { ...view, rows: removeAt(view.rows, index) };
};
