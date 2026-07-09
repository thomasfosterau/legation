/**
 * LiveView
 *
 * A modular, incrementally-maintained materialized view: a subset's result
 * (filtered, sorted, windowed) kept current by row deltas instead of
 * re-scanning the collection. This is the caching/live-view primitive behind
 * paginated live queries, and the window is sliced from the maintained order,
 * so a change outside the page never re-sorts it.
 *
 * Locating the row a `put`/`del` touches is *O(log n)* for distinct sort keys
 * (a binary search on the sort key), degrading to *O(log n + equal-key run)*
 * when several rows share a sort key (and to a full scan when there is no
 * `orderBy`, so every row ties). An id index (`byId`) makes an absent id an
 * *O(1)* no-op — no scan at all. The immutable rebuild of the ordered array on
 * a genuine change is still *O(n)*; the index only removes the linear *search*.
 *
 * The view holds the *full* filtered + sorted matching set so the window stays
 * correct across the limit boundary (an insert can push a row out of the page;
 * a delete can pull the next one in). It is pure data: every update returns a
 * new view (or the same reference when nothing changed), composing cleanly with
 * an `Effect` `Stream`.
 */

import type * as Index from "./CollectionIndex.js";
import * as Predicate from "./Predicate.js";
import * as Subset from "./Subset.js";

export type Row = Subset.Row;

export interface LiveView {
  readonly subset: Subset.Subset;
  /** Full filtered + sorted matching set; the window is sliced by `result`. */
  readonly rows: ReadonlyArray<Row>;
  /**
   * id → its current row, mirroring `rows` membership exactly. Gives O(1)
   * presence checks (so an absent id short-circuits without scanning) and the
   * row's stored value, which a `put`/`del` binary-searches to locate its
   * sorted position.
   */
  readonly byId: ReadonlyMap<string, Row>;
}

const indexById = (rows: ReadonlyArray<Row>): ReadonlyMap<string, Row> => {
  const byId = new Map<string, Row>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
};

/** Build a view from an unordered collection snapshot. */
export const make = (subset: Subset.Subset, rows: ReadonlyArray<Row>): LiveView => {
  const sorted = Subset.sortFiltered(rows, subset);
  return { subset, rows: sorted, byId: indexById(sorted) };
};

/**
 * {@link make}, but reading rows from an id-keyed map with optional secondary-index
 * acceleration (issue #113) — the collection-scale rebuild path (`Rebuild`
 * view changes, a change-hub seq-gap collapse) shares the same narrowing as
 * one-shot `query`.
 */
export const makeIndexed = (
  subset: Subset.Subset,
  rowsById: ReadonlyMap<string, Row>,
  index?: Index.CollectionIndex
): LiveView => {
  const sorted = Subset.sortFilteredIndexed(rowsById, subset, index);
  return { subset, rows: sorted, byId: indexById(sorted) };
};

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
 * Locate an id whose stored `value` is known: binary-search to the first row
 * with an equal sort key, then scan only that equal-key run for the id. Returns
 * -1 if absent. For distinct sort keys the run is a single row (O(log n)).
 */
const indexOf = (
  rows: ReadonlyArray<Row>,
  id: string,
  value: unknown,
  compare: (a: unknown, b: unknown) => number
): number => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid]!.value, value) < 0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < rows.length && compare(rows[i]!.value, value) === 0; i++) {
    if (rows[i]!.id === id) return i;
  }
  return -1;
};

const withoutId = (view: LiveView, id: string): { byId: Map<string, Row> } => {
  const byId = new Map(view.byId);
  byId.delete(id);
  return { byId };
};

/**
 * Apply a row upsert: place it at its sorted position if it matches the
 * predicate, or remove it if it no longer does. Returns the same view reference
 * when the row neither matched before nor matches now (an O(1) `byId` check).
 */
export const put = (view: LiveView, row: Row): LiveView => {
  const matches = Predicate.test(view.subset.where, row.value);
  const existing = view.byId.get(row.id);
  if (!matches && existing === undefined) return view;
  const compare = Subset.comparator(view.subset.orderBy);
  const without =
    existing === undefined
      ? view.rows
      : removeAt(view.rows, indexOf(view.rows, row.id, existing.value, compare));
  if (!matches) return { ...view, rows: without, ...withoutId(view, row.id) };
  const byId = new Map(view.byId);
  byId.set(row.id, row);
  return { ...view, rows: insertSorted(without, row, compare), byId };
};

/** Apply a row deletion. Returns the same view reference if the id is absent. */
export const del = (view: LiveView, id: string): LiveView => {
  const existing = view.byId.get(id);
  if (existing === undefined) return view;
  const index = indexOf(view.rows, id, existing.value, Subset.comparator(view.subset.orderBy));
  if (index < 0) return view;
  return { ...view, rows: removeAt(view.rows, index), ...withoutId(view, id) };
};
