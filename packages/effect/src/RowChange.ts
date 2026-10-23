/**
 * RowChange
 *
 * Row-level deltas anchored to a subset's *result* — its windowed page, not
 * its full matching set — so a predicate or limit-boundary crossing produces
 * the same `enter`/`exit` a consumer diffing two `observe()` pages by hand
 * would derive (#115). `update` marks a same-membership value change;
 * `move` marks a same-membership, same-value row whose stable position (#112)
 * shifted — a neighbor entering/leaving the window re-ranked it without its
 * own value changing; `reset` marks a batch the consumer cannot diff against
 * (a `ViewChange.Rebuild` or a seq-gap collapse — the view could have shifted
 * any row, mirroring the page-level fallback both `ClientEngine` and `Mirror`
 * already use) and is always followed, in the same batch, by fresh `enter`s
 * for the current window.
 *
 * `position` (on `enter`/`update`) and `previousPosition`/`position` (on
 * `move`) are the row's {@link FractionalIndex} sort key within the window —
 * present whenever the source rows carry one (`LiveView.PositionedRow`,
 * i.e. `ClientEngine.observeChanges`) and absent otherwise (a `Mirror`,
 * which has no incrementally-maintained window of its own and so cannot
 * derive stable positions from the whole-page snapshots it diffs — a
 * documented gap, not a silent one; see `Mirror.observeChanges`). A consumer
 * that doesn't need order can ignore `position` entirely and treat `move` as
 * a no-op (the row's `value` is unchanged).
 *
 * `diff`/`reset`/`enters` are the shared primitives `ClientEngine.
 * observeChanges` and `Mirror.observeChanges` both fold their inputs
 * through, so the two hosts (ADR-0021) emit identical batches from
 * identical page transitions (module the `position`/`move` gap above).
 */
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import type { RowId } from "./Collection.js";

/** One change in an observed window: a row entered, updated, moved or exited, or a `reset`. */
export type RowChange<Row> =
  | { readonly _tag: "enter"; readonly row: Row; readonly position?: string }
  | {
      readonly _tag: "update";
      readonly row: Row;
      readonly previous: Row;
      readonly position?: string;
    }
  | {
      readonly _tag: "move";
      readonly row: Row;
      readonly position: string;
      readonly previousPosition: string;
    }
  | { readonly _tag: "exit"; readonly id: RowId; readonly previous: Row }
  | { readonly _tag: "reset" };

interface Identified {
  readonly id: RowId;
  readonly value: unknown;
}

/** A row carrying a stable position key (`LiveView.PositionedRow`'s shape). */
interface Positioned extends Identified {
  readonly position: string;
}

const positionOf = (row: Identified): string | undefined => {
  const position = (row as Partial<Positioned>).position;
  return P.isString(position) ? position : undefined;
};

/** One `enter` per row of `rows`, in order, carrying `position` when present. */
export const enters = <Row extends Identified>(
  rows: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> =>
  rows.map((row) => {
    const position = positionOf(row);
    return position === undefined ? { _tag: "enter", row } : { _tag: "enter", row, position };
  });

/** The Rebuild/gap-collapse batch: a `reset` marker followed by fresh `enter`s. */
export const reset = <Row extends Identified>(
  rows: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> => [{ _tag: "reset" }, ...enters(rows)];

/**
 * One `next` row's decision against its `previous` counterpart (`undefined`
 * when the row is new): `enter`, `update`, `move`, or `undefined` when
 * nothing about it changed. Split out of {@link diff} so the id-membership
 * scan stays a plain loop over this single-row decision.
 */
const changeFor = <Row extends Identified>(
  row: Row,
  before: Row | undefined
): RowChange<Row> | undefined => {
  const position = positionOf(row);
  if (before === undefined) {
    return position === undefined ? { _tag: "enter", row } : { _tag: "enter", row, position };
  }
  if (before.value !== row.value) {
    return position === undefined
      ? { _tag: "update", row, previous: before }
      : { _tag: "update", row, previous: before, position };
  }
  const previousPosition = positionOf(before);
  if (position !== undefined && previousPosition !== undefined && position !== previousPosition) {
    return { _tag: "move", row, position, previousPosition };
  }
  return undefined;
};

/**
 * Diff two windowed pages by id: a row only in `next` enters, a row only in
 * `previous` exits (carrying its last value), a row in both whose `value`
 * reference changed updates, and — when both sides carry a `position` — a row
 * whose value is unchanged but whose position moved emits `move` instead of
 * being silently dropped ({@link changeFor}). Order: `enter`/`update`/`move`
 * in `next`'s order, then `exit`s — batched, not positional beyond the
 * `position` field itself. Returns `[]` when nothing changed (including the
 * `previous === next` fast path), which the observers filter out rather than
 * emit an empty batch.
 */
export const diff = <Row extends Identified>(
  previous: ReadonlyArray<Row>,
  next: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> => {
  if (previous === next) return [];
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const nextIds = new Set<RowId>();
  const changes: Array<RowChange<Row>> = [];
  Arr.forEach(next, (row) => {
    nextIds.add(row.id);
    const change = changeFor(row, previousById.get(row.id));
    if (change !== undefined) changes.push(change);
  });
  Arr.forEach(previous, (row) => {
    if (!nextIds.has(row.id)) changes.push({ _tag: "exit", id: row.id, previous: row });
  });
  return changes;
};
