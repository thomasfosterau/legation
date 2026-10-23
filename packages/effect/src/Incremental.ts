/**
 * Incremental
 *
 * The pure delta engines behind #114's derived combinators ({@link Derive}).
 * ADR-0027 (decision 4) blesses the proven per-module seams over extracting a
 * shared #108 operator core, and rules that #114's combinators *are* the
 * operator layer, landing with their consumer — so these are exactly those
 * combinators' engines, not a separately-consumed core. Each mirrors a proven
 * seam's *technique* (not its coupled code): `join` the keyed-bucket-plus-
 * reverse-index of `Related.makeJoinEngine`, `groupBy` the running-fold-plus-
 * `byId` of `Aggregate`, `orderedWindow` the `LiveView`/`OrderedTree`
 * persistent order.
 *
 * The delta currency is keyed `added`/`removed` rows — the `Patch`-op model of
 * ADR-0027 §1, on row identity, not `[value, ±multiplicity]` multiset entries.
 * Each engine is a small, pure, Effect-free function that emits the delta to
 * its result, never a refold of the whole input (a refolding version of this
 * tier was explicitly judged not worth shipping, #114 brief) — and being pure
 * and stream-free is what lets a property test drive it against a naive
 * from-scratch recompute after every prefix of a randomized delta sequence.
 *
 * **The boundary rule (ADR-0027 §3).** These operators are read-layer
 * machinery behind `observe`. They see only rows the client already holds;
 * they never widen what syncs, never serialize, and are never auth-relevant.
 * The serializable `Subset`/`Predicate` tier alone decides what the server
 * ships.
 *
 * The unit is a {@link Row} — the same `(id, value)` shape as `Subset.Row` and
 * `ClientEngine.LocalRow`, so a source's page (`ReadonlyArray<LocalRow>`) is a
 * valid input and an operator's result rows compose as the input of the next
 * operator (queries-from-queries falls out of the shared shape). Output row
 * ids are synthesized where the operation demands it — a join row is keyed by
 * its `(leftId, rightId)` pair, a group row by its group key, a distinct row
 * by its canonical value — always a plain string, always stable.
 */

import * as Arr from "effect/Array";
import * as Hash from "./Hash.js";
import * as LiveView from "./LiveView.js";
import * as Predicate from "./Predicate.js";
import type { RowChange } from "./RowChange.js";
import * as Subset from "./Subset.js";

/** A `(id, value)` row — structurally `Subset.Row` / `ClientEngine.LocalRow`. */
export interface Row {
  readonly id: string;
  readonly value: unknown;
}

/**
 * A batch of row changes. An update is carried as a `removed` (old value)
 * paired with an `added` (new value) for the same id — the shape
 * {@link diff} produces from consecutive page snapshots, and the shape every
 * operator's `step` accepts and returns.
 */
export interface Delta {
  readonly added: ReadonlyArray<Row>;
  readonly removed: ReadonlyArray<Row>;
}

/** The empty delta (a no-op step result). */
export const emptyDelta: Delta = { added: [], removed: [] };

// ─── Snapshot ↔ delta (the source boundary) ──────────────────────────────────
//
// The derived tier consumes `ClientView.observe` page snapshots and recovers
// row deltas by diffing consecutive pages here — the page-diffing path
// ADR-0027 §4 describes, the same internal re-diff `Related` does, and the
// fallback `Derive.maintain` keeps for a plain page source. When the leaf is
// a `ClientView` (`Derive.observed`), #115's `observeChanges` enter/update/
// exit/move feed is consumed directly instead: `deltaFromChanges` below reads
// the delta `LiveView` already computed rather than recomputing it by diffing
// two page `Map`s.

/** Index a page by id, for diffing against the next snapshot. */
export const indexById = (rows: ReadonlyArray<Row>): Map<string, Row> => {
  const map = new Map<string, Row>();
  for (const row of rows) map.set(row.id, row);
  return map;
};

/**
 * Diff a new page against the previous snapshot (by id, value change detected
 * by content hash): a new id is an `added`, a vanished id a `removed`, a
 * changed value a `removed` (old) + `added` (new). Returns the delta and the
 * new snapshot index to carry forward.
 */
export const diff = (
  previous: ReadonlyMap<string, Row>,
  next: ReadonlyArray<Row>
): { readonly delta: Delta; readonly index: Map<string, Row> } => {
  const added: Array<Row> = [];
  const removed: Array<Row> = [];
  const index = new Map<string, Row>();
  for (const row of next) {
    index.set(row.id, row);
    const prior = previous.get(row.id);
    if (prior === undefined) added.push(row);
    else if (prior !== row && Hash.contentHash(prior.value) !== Hash.contentHash(row.value)) {
      removed.push(prior);
      added.push(row);
    }
  }
  for (const [id, prior] of previous) {
    if (!index.has(id)) removed.push(prior);
  }
  return { delta: { added, removed }, index };
};

/** Fold a delta into a maintained result map (remove ids, then set adds). */
export const applyDelta = (result: Map<string, Row>, delta: Delta): void => {
  for (const row of delta.removed) result.delete(row.id);
  for (const row of delta.added) result.set(row.id, row);
};

/**
 * Recover a {@link Delta} directly from an `observeChanges` batch (#115),
 * instead of diffing two page snapshots (see {@link diff} above) — the
 * optimization ADR-0027 §4 and this module's header flag as a follow-up:
 * `LiveView` already decided enter/update/exit/move per row, so this just
 * reads that decision instead of recomputing it from two `Map`s. `known`
 * tracks the last row seen per id (across calls, mutated in place) so a
 * `reset` can emit a `removed` for everything it cleared — the same
 * information a page-diff's `previous` snapshot would have given for free.
 * `move` carries no value change, so it contributes nothing to the delta.
 */
export const deltaFromChanges = (
  known: Map<string, Row>,
  batch: ReadonlyArray<RowChange<Row>>
): Delta => {
  const added: Array<Row> = [];
  const removed: Array<Row> = [];
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

/** Materialize a result map to a page in a deterministic (id-ascending, code-point) order. */
export const pageOf = (result: ReadonlyMap<string, Row>): ReadonlyArray<Row> =>
  [...result.values()].toSorted((a, b) => Predicate.compareText(a.id, b.id));

// ─── Operators ───────────────────────────────────────────────────────────────

/** A single-input delta→delta operator maintaining its own internal state. */
export interface Operator {
  readonly step: (delta: Delta) => Delta;
}

/**
 * `filter` — keep rows whose value passes an arbitrary JS predicate. Stateless
 * per row: the predicate is deterministic on the value, and a delta carries the
 * value it concerns, so an added/removed row's membership is decided on the
 * spot (an update that filters a row out is a `removed` with the old value that
 * passed; one that filters it in is an `added` that now passes).
 */
export const makeFilter = (predicate: (value: unknown) => boolean): Operator => ({
  step: (delta) => ({
    added: delta.added.filter((row) => predicate(row.value)),
    removed: delta.removed.filter((row) => predicate(row.value)),
  }),
});

/** {@link makeFilter}'s naive recompute, for the property test. */
export const filterFromScratch = (
  rows: ReadonlyArray<Row>,
  predicate: (value: unknown) => boolean
): Map<string, Row> => indexById(rows.filter((row) => predicate(row.value)));

/**
 * `map`/select — project each value through an arbitrary JS function, keeping
 * the row id (projection preserves identity). Stateless: `f` is deterministic,
 * so an update's `removed` reconstructs the old projection and its `added` the
 * new one.
 */
export const makeMap = (f: (value: unknown) => unknown): Operator => ({
  step: (delta) => ({
    added: delta.added.map((row) => ({ id: row.id, value: f(row.value) })),
    removed: delta.removed.map((row) => ({ id: row.id, value: f(row.value) })),
  }),
});

/** {@link makeMap}'s naive recompute. */
export const mapFromScratch = (
  rows: ReadonlyArray<Row>,
  f: (value: unknown) => unknown
): Map<string, Row> => indexById(rows.map((row) => ({ id: row.id, value: f(row.value) })));

/**
 * `distinct` — collapse duplicate values to one row, keyed and identified by
 * the value's canonical serialization (so value equality, not reference,
 * decides duplication and there is no hash-collision risk). A multiplicity
 * count per distinct value means removing one of several duplicates keeps the
 * distinct row; the row appears when its count goes 0→1 and disappears at 1→0.
 */
export const makeDistinct = (): Operator => {
  const counts = new Map<string, { count: number; readonly value: unknown }>();
  return {
    step: (delta) => {
      const added: Array<Row> = [];
      const removed: Array<Row> = [];
      for (const row of delta.removed) {
        const key = Hash.canonicalJson(row.value);
        const entry = counts.get(key);
        if (entry === undefined) continue;
        entry.count -= 1;
        if (entry.count === 0) {
          counts.delete(key);
          removed.push({ id: key, value: entry.value });
        }
      }
      for (const row of delta.added) {
        const key = Hash.canonicalJson(row.value);
        const entry = counts.get(key);
        if (entry === undefined) {
          counts.set(key, { count: 1, value: row.value });
          added.push({ id: key, value: row.value });
        } else {
          entry.count += 1;
        }
      }
      return { added, removed };
    },
  };
};

/** {@link makeDistinct}'s naive recompute (dedupe by canonical value). */
export const distinctFromScratch = (rows: ReadonlyArray<Row>): Map<string, Row> => {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const key = Hash.canonicalJson(row.value);
    if (!result.has(key)) result.set(key, { id: key, value: row.value });
  }
  return result;
};

/**
 * `groupBy` returning grouped **rows** (not only scalar aggregates): one output
 * row per group, `value` = `{ key, rows }` where `rows` are the group members'
 * values ordered by member id (a deterministic within-group order, so a
 * from-scratch recompute matches). Only the one or two groups a delta touches
 * re-materialize — every other group's row is untouched (the same
 * touch-only-the-affected-bucket discipline as `Aggregate`'s grouped state).
 */
export const makeGroupBy = (key: (value: unknown) => string): Operator => {
  const groups = new Map<string, Map<string, unknown>>();
  const groupOf = new Map<string, string>();
  const lastRow = new Map<string, Row>();

  const groupRow = (groupKey: string): Row => {
    const members = groups.get(groupKey)!;
    const rows = [...members.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value);
    return { id: groupKey, value: { key: groupKey, rows } };
  };

  return {
    step: (delta) => {
      const touched = new Set<string>();
      for (const row of delta.removed) {
        const groupKey = groupOf.get(row.id);
        if (groupKey === undefined) continue;
        const members = groups.get(groupKey)!;
        members.delete(row.id);
        groupOf.delete(row.id);
        if (members.size === 0) groups.delete(groupKey);
        touched.add(groupKey);
      }
      for (const row of delta.added) {
        const groupKey = key(row.value);
        let members = groups.get(groupKey);
        if (members === undefined) {
          members = new Map();
          groups.set(groupKey, members);
        }
        members.set(row.id, row.value);
        groupOf.set(row.id, groupKey);
        touched.add(groupKey);
      }
      const added: Array<Row> = [];
      const removed: Array<Row> = [];
      for (const groupKey of touched) {
        const previous = lastRow.get(groupKey);
        if (previous !== undefined) removed.push(previous);
        if (groups.has(groupKey)) {
          const next = groupRow(groupKey);
          added.push(next);
          lastRow.set(groupKey, next);
        } else {
          lastRow.delete(groupKey);
        }
      }
      return { added, removed };
    },
  };
};

/** A group row's value shape (what {@link makeGroupBy} emits). */
export interface Group {
  readonly key: string;
  readonly rows: ReadonlyArray<unknown>;
}

/** {@link makeGroupBy}'s naive recompute. */
export const groupByFromScratch = (
  rows: ReadonlyArray<Row>,
  key: (value: unknown) => string
): Map<string, Row> => {
  const groups = new Map<string, Array<[string, unknown]>>();
  for (const row of rows) {
    const groupKey = key(row.value);
    const bucket = groups.get(groupKey) ?? [];
    bucket.push([row.id, row.value]);
    groups.set(groupKey, bucket);
  }
  const result = new Map<string, Row>();
  for (const [groupKey, bucket] of groups) {
    const ordered = bucket
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value);
    result.set(groupKey, { id: groupKey, value: { key: groupKey, rows: ordered } });
  }
  return result;
};

// ─── Join (inner + left) ─────────────────────────────────────────────────────

/** How a joined row's value is assembled; default `{ left, right }`. */
export type JoinCombine = (left: unknown, right: unknown | null) => unknown;

/** Options for {@link makeJoin} / {@link joinFromScratch}. */
export interface JoinOptions {
  /** Extract the left row's join key (an arbitrary value; `null`/`undefined` never matches). */
  readonly leftKey: (value: unknown) => unknown;
  /** Extract the right row's join key. */
  readonly rightKey: (value: unknown) => unknown;
  /** `inner` drops unmatched left rows; `left` keeps them with a `null` right. */
  readonly kind: "inner" | "left";
  /** Assemble the joined value; defaults to `{ left, right }`. */
  readonly combine?: JoinCombine;
}

const NUL = "\u0000";
const defaultCombine: JoinCombine = (left, right) => ({ left, right });

/** A join key's canonical string, or `undefined` for a non-joining `null`/`undefined` key. */
const joinKey = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : Hash.canonicalJson(value);

/**
 * A two-input join over arbitrary key equality (inner or left). Maintains,
 * per side, an id→row map and a key→ids index; a change re-derives only the
 * left rows whose key the change touches (a right delta re-hydrates only the
 * lefts in the affected buckets; a left delta only itself) — never a full
 * re-group, the same discipline as `Related.makeJoinEngine`. Left-join null
 * rows fall out for free: an unmatched left's contribution is a single
 * `combine(left, null)` row, replaced the moment a matching right arrives.
 */
export interface JoinOperator {
  readonly stepLeft: (delta: Delta) => Delta;
  readonly stepRight: (delta: Delta) => Delta;
}

/** Build a {@link JoinOperator} for the given join keys and kind (inner or left). */
export const makeJoin = (options: JoinOptions): JoinOperator => {
  const combine = options.combine ?? defaultCombine;
  const leftById = new Map<string, Row>();
  const rightById = new Map<string, Row>();
  const rightByKey = new Map<string, Map<string, unknown>>();
  const leftByKey = new Map<string, Set<string>>();
  const contribution = new Map<string, Map<string, Row>>();

  const contributionOf = (leftId: string): Map<string, Row> => {
    const out = new Map<string, Row>();
    const left = leftById.get(leftId);
    if (left === undefined) return out;
    const key = joinKey(options.leftKey(left.value));
    const rights = key === undefined ? undefined : rightByKey.get(key);
    if (rights !== undefined && rights.size > 0) {
      for (const [rightId, rightValue] of rights) {
        const id = `${leftId}${NUL}${rightId}`;
        out.set(id, { id, value: combine(left.value, rightValue) });
      }
    } else if (options.kind === "left") {
      const id = `${leftId}${NUL}`;
      out.set(id, { id, value: combine(left.value, null) });
    }
    return out;
  };

  /** Recompute one left row's contribution and emit the diff against its last. */
  const reconcile = (leftId: string, added: Array<Row>, removed: Array<Row>): void => {
    const previous = contribution.get(leftId) ?? new Map<string, Row>();
    const next = contributionOf(leftId);
    for (const [id, row] of previous) {
      if (!next.has(id)) removed.push(row);
    }
    for (const [id, row] of next) {
      const prior = previous.get(id);
      if (prior === undefined) added.push(row);
      else if (Hash.contentHash(prior.value) !== Hash.contentHash(row.value)) {
        removed.push(prior);
        added.push(row);
      }
    }
    if (next.size > 0) contribution.set(leftId, next);
    else contribution.delete(leftId);
  };

  const indexLeft = (row: Row): void => {
    leftById.set(row.id, row);
    const key = joinKey(options.leftKey(row.value));
    if (key === undefined) return;
    const set = leftByKey.get(key) ?? new Set<string>();
    set.add(row.id);
    leftByKey.set(key, set);
  };

  const unindexLeft = (row: Row): void => {
    leftById.delete(row.id);
    const key = joinKey(options.leftKey(row.value));
    if (key === undefined) return;
    const set = leftByKey.get(key);
    if (set === undefined) return;
    set.delete(row.id);
    if (set.size === 0) leftByKey.delete(key);
  };

  const putRight = (row: Row, keys: Set<string>): void => {
    const key = joinKey(options.rightKey(row.value));
    rightById.set(row.id, row);
    if (key === undefined) return;
    const bucket = rightByKey.get(key) ?? new Map<string, unknown>();
    bucket.set(row.id, row.value);
    rightByKey.set(key, bucket);
    keys.add(key);
  };

  const removeRight = (row: Row, keys: Set<string>): void => {
    const key = joinKey(options.rightKey(row.value));
    rightById.delete(row.id);
    if (key === undefined) return;
    const bucket = rightByKey.get(key);
    if (bucket === undefined) return;
    bucket.delete(row.id);
    if (bucket.size === 0) rightByKey.delete(key);
    keys.add(key);
  };

  return {
    stepLeft: (delta) => {
      const affected = new Set<string>();
      for (const row of delta.removed) {
        unindexLeft(row);
        affected.add(row.id);
      }
      for (const row of delta.added) {
        const prior = leftById.get(row.id);
        if (prior !== undefined) unindexLeft(prior);
        indexLeft(row);
        affected.add(row.id);
      }
      const added: Array<Row> = [];
      const removed: Array<Row> = [];
      for (const leftId of affected) reconcile(leftId, added, removed);
      return { added, removed };
    },
    stepRight: (delta) => {
      const keys = new Set<string>();
      for (const row of delta.removed) removeRight(row, keys);
      for (const row of delta.added) {
        const prior = rightById.get(row.id);
        if (prior !== undefined) removeRight(prior, keys);
        putRight(row, keys);
      }
      const affectedLefts = new Set<string>();
      for (const key of keys) {
        const ids = leftByKey.get(key);
        if (ids !== undefined) for (const id of ids) affectedLefts.add(id);
      }
      const added: Array<Row> = [];
      const removed: Array<Row> = [];
      for (const leftId of affectedLefts) reconcile(leftId, added, removed);
      return { added, removed };
    },
  };
};

/** {@link makeJoin}'s naive recompute (nested-loop join by key equality). */
export const joinFromScratch = (
  left: ReadonlyArray<Row>,
  right: ReadonlyArray<Row>,
  options: JoinOptions
): Map<string, Row> => {
  const combine = options.combine ?? defaultCombine;
  const rightByKey = new Map<string, Array<Row>>();
  for (const row of right) {
    const key = joinKey(options.rightKey(row.value));
    if (key === undefined) continue;
    const bucket = rightByKey.get(key) ?? [];
    bucket.push(row);
    rightByKey.set(key, bucket);
  }
  const result = new Map<string, Row>();
  for (const leftRow of left) {
    const key = joinKey(options.leftKey(leftRow.value));
    const matches = key === undefined ? undefined : rightByKey.get(key);
    if (matches !== undefined && Arr.isReadonlyArrayNonEmpty(matches)) {
      for (const rightRow of matches) {
        const id = `${leftRow.id}${NUL}${rightRow.id}`;
        result.set(id, { id, value: combine(leftRow.value, rightRow.value) });
      }
    } else if (options.kind === "left") {
      const id = `${leftRow.id}${NUL}`;
      result.set(id, { id, value: combine(leftRow.value, null) });
    }
  }
  return result;
};

// ─── Ordered window (orderBy + limit) ────────────────────────────────────────

/** An ordered-window operator maintaining a `LiveView` over derived rows. */
export interface OrderedWindow {
  /** Apply a delta; returns the current window, ordered and limited. */
  readonly step: (delta: Delta) => ReadonlyArray<Row>;
}

/** The subset an ordered window maintains (an always-true `where` over derived rows). */
const windowSubset = (
  orderBy: ReadonlyArray<Subset.OrderBy>,
  limit: number | undefined
): Subset.Subset =>
  Subset.make({ collection: "", orderBy, ...(limit === undefined ? {} : { limit }) });

/**
 * `orderedWindow` — sort derived rows by an `orderBy` and keep the first
 * `limit`. Reuses `LiveView` (the `OrderedTree` + fractional-index machinery of
 * #112): a delta is folded in as O(log n) `put`/`del`s and the window resliced
 * without a re-sort, so a change outside the page costs the same as one inside
 * it. Order is `Subset.comparator` — the one ordering authority (ADR-0026), so
 * "no orderBy" still means a stable id-ascending order.
 */
export const makeOrderedWindow = (
  orderBy: ReadonlyArray<Subset.OrderBy>,
  limit?: number
): OrderedWindow => {
  const subset = windowSubset(orderBy, limit);
  let view = LiveView.make(subset, []);
  return {
    step: (delta) => {
      for (const row of delta.removed) view = LiveView.del(view, row.id);
      for (const row of delta.added) view = LiveView.put(view, { id: row.id, value: row.value });
      return LiveView.result(view).map((row) => ({ id: row.id, value: row.value }));
    },
  };
};

/** {@link makeOrderedWindow}'s naive recompute (`Subset.apply`: sort then window). */
export const orderedWindowFromScratch = (
  rows: ReadonlyArray<Row>,
  orderBy: ReadonlyArray<Subset.OrderBy>,
  limit?: number
): ReadonlyArray<Row> =>
  Subset.apply(rows, windowSubset(orderBy, limit)).map((row) => ({ id: row.id, value: row.value }));
