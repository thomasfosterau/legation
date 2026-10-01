/**
 * LiveView
 *
 * A modular, incrementally-maintained materialized view: a subset's result
 * (filtered, sorted, windowed) kept current by row deltas instead of
 * re-scanning the collection. This is the caching/live-view primitive behind
 * paginated live queries, and the window is sliced from the maintained order,
 * so a change outside the page never re-sorts it.
 *
 * The maintained order lives in an {@link OrderedTree} (issue #112), not a
 * copied array: `Subset.comparator`'s id tie-break makes every row's sort key
 * distinct, so locating the row a `put`/`del` touches is genuinely *O(log
 * n)* — including for an empty `orderBy`, where every row used to tie and
 * `indexOf` degraded to a full scan. The tree's own insert/remove are
 * *O(log n)* node allocations (path-copying, not an array rebuild), and
 * `result` reslices the window from it in *O(log n + window)* — so a change
 * outside the visible page costs the same as one inside it: locate, no
 * rebuild. The id index (`byId`) is a *second* tree, ordered by id instead of
 * by the subset's comparator: an absent id is an O(log n) no-op, and —
 * unlike a `Map`, whose `new Map(bigMap)` is O(n) — updating one entry never
 * touches the rest, which is what keeps a genuine-change `put`/`del` at
 * O(log n) instead of silently degrading to O(n) on a large collection.
 *
 * The view holds the *full* filtered + sorted matching set so the window
 * stays correct across the limit boundary (an insert can push a row out of
 * the page; a delete can pull the next one in) and so `retarget` can widen
 * or advance the window over the *same* maintained order — no
 * re-materialization, the TanStack-DB-style `setWindowFn` analogue for
 * `Subset`'s cursor/limit widening (`useConnection`'s "load more"). It is
 * pure data: every update returns a new view (or the same reference when
 * nothing changed), composing cleanly with an `Effect` `Stream`.
 *
 * In-window rows carry a stable {@link FractionalIndex} `position`: assigned
 * when a row enters the window, dropped when it leaves, and left untouched
 * when neither the row nor its immediate neighbors moved — so a downstream
 * delta consumer (`RowChange.diff`, driving `ClientEngine.observeChanges`)
 * can tell "entered"/"left"/"moved" apart without diffing pages, the way
 * TanStack DB's `topKWithFractionalIndex` does for its own maintained window.
 */

import type * as Index from "./CollectionIndex.js";
import * as FractionalIndex from "./FractionalIndex.js";
import * as OrderedTree from "./OrderedTree.js";
import * as Predicate from "./Predicate.js";
import * as Subset from "./Subset.js";

/** A materialized `(id, value)` row, as a subset produces it. */
export type Row = Subset.Row;

/** A {@link Row} carrying its stable in-window position (see the module doc). */
export interface PositionedRow extends Row {
  readonly position: string;
}

/**
 * One subset's incrementally maintained window: the matching rows in subset order, plus an id
 * index over the same rows.
 */
export interface LiveView {
  readonly subset: Subset.Subset;
  /** The full filtered + sorted matching set, maintained as an ordered tree. */
  readonly order: OrderedTree.Tree<Row>;
  /**
   * The same rows, maintained as a second tree ordered by id — an id index
   * that supports an O(log n) presence check and O(log n) update, unlike a
   * `Map` (see the module doc for why that distinction matters here).
   */
  readonly byId: OrderedTree.Tree<Row>;
  /** id → stable position, for rows currently inside the window only. */
  readonly positions: ReadonlyMap<string, string>;
}

// Ids order by code point, the same order `Subset.comparator`'s tie-break uses (ADR-0028).
const byIdCompare = (a: Row, b: Row): number => Predicate.compareText(a.id, b.id);
const findById = (byId: OrderedTree.Tree<Row>, id: string): Row | undefined =>
  OrderedTree.findBy(byId, id, (key, row) => Predicate.compareText(key, row.id));

const compareOf = (subset: Subset.Subset) => Subset.comparator(subset.orderBy);

/** The window's start rank (0 if no cursor, or the row after it) and length. */
const windowSlice = (
  order: OrderedTree.Tree<Row>,
  byId: OrderedTree.Tree<Row>,
  subset: Subset.Subset
): ReadonlyArray<Row> => {
  let from = 0;
  if (subset.cursor !== undefined) {
    const cursorRow = findById(byId, subset.cursor);
    if (cursorRow !== undefined) {
      const rank = OrderedTree.rankOf(order, cursorRow, compareOf(subset));
      from = rank < 0 ? 0 : rank + 1;
    }
  }
  const count = subset.limit === undefined ? OrderedTree.size(order) - from : subset.limit;
  return OrderedTree.slice(order, from, Math.max(count, 0));
};

/**
 * Whether row `i`'s previous position is still ordered correctly against its
 * *previous* immediate neighbors — cheap to check, and exactly the "row
 * didn't move relative to what's next to it" condition that lets a position
 * survive unchanged.
 */
const stillOrdered = (
  windowRows: ReadonlyArray<Row>,
  previous: ReadonlyMap<string, string>,
  i: number,
  position: string
): boolean => {
  const leftPrev = i > 0 ? previous.get(windowRows[i - 1]!.id) : undefined;
  const rightPrev = i < windowRows.length - 1 ? previous.get(windowRows[i + 1]!.id) : undefined;
  const okLeft = leftPrev === undefined || FractionalIndex.compare(leftPrev, position) < 0;
  const okRight = rightPrev === undefined || FractionalIndex.compare(position, rightPrev) < 0;
  return okLeft && okRight;
};

/** Each window row's reusable previous position, or `undefined` where a fresh one is needed. */
const reusablePositions = (
  windowRows: ReadonlyArray<Row>,
  previous: ReadonlyMap<string, string>
): ReadonlyArray<string | undefined> =>
  windowRows.map((row, i) => {
    const existing = previous.get(row.id);
    return existing !== undefined && stillOrdered(windowRows, previous, i, existing)
      ? existing
      : undefined;
  });

/** Fill every gap between reused positions with a fresh, evenly-spaced batch. */
const fillGaps = (
  windowRows: ReadonlyArray<Row>,
  reused: ReadonlyArray<string | undefined>
): ReadonlyMap<string, string> => {
  const n = windowRows.length;
  const next = new Map<string, string>();
  let left: string | undefined;
  let i = 0;
  while (i < n) {
    if (reused[i] !== undefined) {
      next.set(windowRows[i]!.id, reused[i]!);
      left = reused[i];
      i++;
      continue;
    }
    let j = i;
    while (j < n && reused[j] === undefined) j++;
    const right = j < n ? reused[j] : undefined;
    const fresh = FractionalIndex.generateNBetween(left, right, j - i);
    for (let k = i; k < j; k++) next.set(windowRows[k]!.id, fresh[k - i]!);
    left = right;
    i = j;
  }
  return next;
};

/**
 * Assign positions to a freshly-computed window, reusing a row's previous
 * position whenever it is still ordered correctly against its previous
 * neighbors — everything else (freshly entered rows, and runs of rows whose
 * old position no longer fits) gets a batch of fresh keys spanning the gap
 * between the nearest reused neighbors, via
 * {@link FractionalIndex.generateNBetween}. O(window).
 */
const positionsFor = (
  windowRows: ReadonlyArray<Row>,
  previous: ReadonlyMap<string, string>
): ReadonlyMap<string, string> => fillGaps(windowRows, reusablePositions(windowRows, previous));

/** Build a view from an unordered collection snapshot. */
export const make = (subset: Subset.Subset, rows: ReadonlyArray<Row>): LiveView => {
  const sorted = Subset.sortFiltered(rows, subset);
  const order = OrderedTree.fromSorted(sorted);
  const byId = OrderedTree.fromSorted(sorted.toSorted(byIdCompare));
  const positions = positionsFor(windowSlice(order, byId, subset), new Map());
  return { subset, order, byId, positions };
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
  const order = OrderedTree.fromSorted(sorted);
  const byId = OrderedTree.fromSorted(sorted.toSorted(byIdCompare));
  const positions = positionsFor(windowSlice(order, byId, subset), new Map());
  return { subset, order, byId, positions };
};

/** The visible page: the subset's cursor + limit over the maintained order. */
export const result = (view: LiveView): ReadonlyArray<PositionedRow> =>
  windowSlice(view.order, view.byId, view.subset).map(
    (row): PositionedRow => ({
      id: row.id,
      value: row.value,
      position: view.positions.get(row.id)!,
    })
  );

/**
 * Retarget the window — a new `limit` and/or `cursor`, e.g. "load more"
 * widening the page — without touching the maintained order: no re-fetch, no
 * re-sort, just a new O(log n + window) slice of the same tree.
 * `collection`/`where`/`orderBy` stay the view's own; only `limit`/`cursor`
 * move, matching `useConnection`'s "load more widens one window" (ADR-0024)
 * — the pure, comparator-shaped half of "widen"; the engine-level API that
 * reactively feeds a widened `limit` to an open subscription (so the client
 * never re-registers it) is `ClientEngine.observeWindow` (#133).
 * Same-reference-on-no-op: returns `view` unchanged if neither `limit` nor
 * `cursor` moved.
 */
export const retarget = (
  view: LiveView,
  window: { readonly limit?: number; readonly cursor?: string }
): LiveView => {
  const limit = window.limit !== undefined ? window.limit : view.subset.limit;
  const cursor = window.cursor !== undefined ? window.cursor : view.subset.cursor;
  if (limit === view.subset.limit && cursor === view.subset.cursor) return view;
  const subset: Subset.Subset = {
    ...view.subset,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  const positions = positionsFor(windowSlice(view.order, view.byId, subset), view.positions);
  return { ...view, subset, positions };
};

/**
 * Apply a row upsert: place it at its sorted position if it matches the
 * predicate, or remove it if it no longer does. Returns the same view
 * reference when the row neither matched before nor matches now (an O(log n)
 * `byId` check).
 */
export const put = (view: LiveView, row: Row): LiveView => {
  const matches = Predicate.test(view.subset.where, row.value);
  const existing = findById(view.byId, row.id);
  if (!matches && existing === undefined) return view;
  const compare = compareOf(view.subset);
  const withoutOld =
    existing === undefined ? view.order : OrderedTree.remove(view.order, existing, compare);
  if (!matches) {
    const byId = OrderedTree.remove(view.byId, row, byIdCompare);
    const positions = positionsFor(windowSlice(withoutOld, byId, view.subset), view.positions);
    return { ...view, order: withoutOld, byId, positions };
  }
  const byId = OrderedTree.insert(view.byId, row, byIdCompare);
  const order = OrderedTree.insert(withoutOld, row, compare);
  const positions = positionsFor(windowSlice(order, byId, view.subset), view.positions);
  return { ...view, order, byId, positions };
};

/** Apply a row deletion. Returns the same view reference if the id is absent. */
export const del = (view: LiveView, id: string): LiveView => {
  const existing = findById(view.byId, id);
  if (existing === undefined) return view;
  const order = OrderedTree.remove(view.order, existing, compareOf(view.subset));
  const byId = OrderedTree.remove(view.byId, existing, byIdCompare);
  const positions = positionsFor(windowSlice(order, byId, view.subset), view.positions);
  return { ...view, order, byId, positions };
};
