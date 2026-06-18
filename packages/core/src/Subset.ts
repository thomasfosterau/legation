/**
 * Subset
 *
 * A collection subset — `(collection, where, orderBy, limit, cursor)` — is
 * the subscription unit of the protocol (CONTEXT.md): the thing a client
 * registers with the server, the thing auth filters narrow, and the thing a
 * CVR tracks. Live queries reuse the same shape locally.
 */

import { Schema } from "effect";
import * as Predicate from "./Predicate.js";

/** Sort direction. */
export type Direction = "asc" | "desc";

/** One sort term: a top-level row field plus direction. */
export interface OrderBy {
  readonly field: string;
  readonly direction: Direction;
}

/**
 * A collection subset. `limit` + `cursor` give cursor-based pagination:
 * "load more" widens the subset (re-register with a larger limit or a
 * cursor at the last row) rather than fetching detached pages.
 */
export interface Subset {
  readonly collection: string;
  readonly where: Predicate.Predicate;
  readonly orderBy: ReadonlyArray<OrderBy>;
  readonly limit?: number | undefined;
  /** Opaque continuation: sync rows ordered after this cursor. */
  readonly cursor?: string | undefined;
}

export const OrderBySchema: Schema.Codec<OrderBy> = Schema.Struct({
  field: Schema.String,
  direction: Schema.Literals(["asc", "desc"]),
}) as Schema.Codec<OrderBy>;

/** Wire codec for {@link Subset}. */
export const SubsetSchema: Schema.Codec<Subset> = Schema.Struct({
  collection: Schema.String,
  where: Predicate.PredicateSchema,
  orderBy: Schema.Array(OrderBySchema),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
}) as Schema.Codec<Subset>;

/** Define a subset; `where` defaults to the whole collection. */
export const make = (options: {
  readonly collection: string;
  readonly where?: Predicate.Predicate;
  readonly orderBy?: ReadonlyArray<OrderBy>;
  readonly limit?: number;
  readonly cursor?: string;
}): Subset => ({
  collection: options.collection,
  where: options.where ?? Predicate.always,
  orderBy: options.orderBy ?? [],
  limit: options.limit,
  cursor: options.cursor,
});

/** Stable identity for a subset (used as CVR / subscription map keys). */
export const hash = (subset: Subset): string => JSON.stringify(subset);

/** A `(id, value)` row — the unit subsets and live views operate over. */
export interface Row {
  readonly id: string;
  readonly value: unknown;
}

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;

/**
 * A comparator over row *values* for an `orderBy`. Stable across the same
 * orderBy, so it can both sort a set and place a single row incrementally
 * (LiveView).
 */
export const comparator =
  (orderBy: ReadonlyArray<OrderBy>) =>
  (a: unknown, b: unknown): number => {
    for (const term of orderBy) {
      const left = fieldOf(a, term.field);
      const right = fieldOf(b, term.field);
      if (left === right) continue;
      if (left === undefined || left === null) return term.direction === "asc" ? -1 : 1;
      if (right === undefined || right === null) return term.direction === "asc" ? 1 : -1;
      const ordered = (left as number | string) < (right as number | string) ? -1 : 1;
      return term.direction === "asc" ? ordered : -ordered;
    }
    return 0;
  };

/** Filter rows by the subset's predicate and sort by its `orderBy` (no window). */
export const sortFiltered = <R extends Row>(
  rows: ReadonlyArray<R>,
  subset: Subset
): ReadonlyArray<R> => {
  const filtered = rows.filter((row) => Predicate.test(subset.where, row.value));
  if (subset.orderBy.length === 0) return filtered;
  const compare = comparator(subset.orderBy);
  return filtered.toSorted((a, b) => compare(a.value, b.value));
};

/**
 * Apply the subset's window to already-filtered, already-sorted rows: cursor
 * (rows strictly after the row whose id equals the cursor) then limit.
 */
export const window = <R extends Row>(rows: ReadonlyArray<R>, subset: Subset): ReadonlyArray<R> => {
  let result = rows;
  if (subset.cursor !== undefined) {
    const index = result.findIndex((row) => row.id === subset.cursor);
    result = index >= 0 ? result.slice(index + 1) : result;
  }
  if (subset.limit !== undefined) result = result.slice(0, subset.limit);
  return result;
};

/**
 * Reference in-memory evaluation of a subset over `(id, value)` rows: filter,
 * sort, then window (cursor + limit). Used by the memory backend, the client
 * mirror, and as the semantics other backends must match.
 */
export const apply = <R extends Row>(rows: ReadonlyArray<R>, subset: Subset): ReadonlyArray<R> =>
  window(sortFiltered(rows, subset), subset);
