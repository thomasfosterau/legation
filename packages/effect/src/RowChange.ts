/**
 * RowChange
 *
 * Row-level deltas anchored to a subset's *result* — its windowed page, not
 * its full matching set — so a predicate or limit-boundary crossing produces
 * the same `enter`/`exit` a consumer diffing two `observe()` pages by hand
 * would derive (#115). `update` marks a same-membership value change;
 * `reset` marks a batch the consumer cannot diff against (a `ViewChange.
 * Rebuild` or a seq-gap collapse — the view could have shifted any row,
 * mirroring the page-level fallback both `ClientEngine` and `Mirror` already
 * use) and is always followed, in the same batch, by fresh `enter`s for the
 * current window.
 *
 * `diff`/`reset`/`enters` are the shared primitives `ClientEngine.
 * observeChanges` and `Mirror.observeChanges` both fold their inputs
 * through, so the two hosts (ADR-0021) emit identical batches from
 * identical page transitions.
 */
import type { RowId } from "./Collection.js";

export type RowChange<Row> =
  | { readonly _tag: "enter"; readonly row: Row }
  | { readonly _tag: "update"; readonly row: Row; readonly previous: Row }
  | { readonly _tag: "exit"; readonly id: RowId; readonly previous: Row }
  | { readonly _tag: "reset" };

interface Identified {
  readonly id: RowId;
  readonly value: unknown;
}

/** One `enter` per row of `rows`, in order. */
export const enters = <Row extends Identified>(
  rows: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> => rows.map((row) => ({ _tag: "enter", row }));

/** The Rebuild/gap-collapse batch: a `reset` marker followed by fresh `enter`s. */
export const reset = <Row extends Identified>(
  rows: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> => [{ _tag: "reset" }, ...enters(rows)];

/**
 * Diff two windowed pages by id: a row only in `next` enters, a row only in
 * `previous` exits (carrying its last value), a row in both whose `value`
 * reference changed updates. Order: `enter`/`update` in `next`'s order, then
 * `exit`s — batched, not positional (stable position keys are #112).
 * Returns `[]` when nothing changed (including the `previous === next`
 * fast path), which the observers filter out rather than emit an empty batch.
 */
export const diff = <Row extends Identified>(
  previous: ReadonlyArray<Row>,
  next: ReadonlyArray<Row>
): ReadonlyArray<RowChange<Row>> => {
  if (previous === next) return [];
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const nextIds = new Set<RowId>();
  const changes: Array<RowChange<Row>> = [];
  for (const row of next) {
    nextIds.add(row.id);
    const before = previousById.get(row.id);
    if (before === undefined) changes.push({ _tag: "enter", row });
    else if (before.value !== row.value) changes.push({ _tag: "update", row, previous: before });
  }
  for (const row of previous) {
    if (!nextIds.has(row.id)) changes.push({ _tag: "exit", id: row.id, previous: row });
  }
  return changes;
};
