/**
 * Subset
 *
 * A collection subset — `(collection, where, orderBy, limit, cursor)` — is
 * the subscription unit of the protocol (CONTEXT.md): the thing a client
 * registers with the server, the thing auth filters narrow, and the thing a
 * CVR tracks. Live queries reuse the same shape locally.
 */

import { Schema } from "effect";
import type { AnyCollection, RowOf } from "./Collection.js";
import * as Index from "./CollectionIndex.js";
import * as Predicate from "./Predicate.js";

/** Sort direction. */
export type Direction = "asc" | "desc";

/** Wire codec for one sort term: a top-level row field plus direction. */
export const OrderBySchema = Schema.Struct({
  field: Schema.String,
  direction: Schema.Literals(["asc", "desc"]),
});

/** One sort term: a top-level row field plus direction. */
export type OrderBy = typeof OrderBySchema.Type;

/** Parse order tokens (`"name"`, `"-createdAt"`) into sort terms. */
export const parseOrder = (tokens: ReadonlyArray<string> | undefined): ReadonlyArray<OrderBy> =>
  (tokens ?? []).map((token) =>
    token.startsWith("-")
      ? { field: token.slice(1), direction: "desc" as const }
      : { field: token, direction: "asc" as const }
  );

/**
 * Wire codec for {@link Subset}. The schema is the source of truth: the
 * `Subset` type is derived from it (`typeof SubsetSchema.Type`) so the two
 * cannot drift.
 */
export const SubsetSchema = Schema.Struct({
  collection: Schema.String,
  where: Predicate.PredicateSchema,
  orderBy: Schema.Array(OrderBySchema),
  limit: Schema.optional(Schema.Number),
  /** Opaque continuation: sync rows ordered after this cursor. */
  cursor: Schema.optional(Schema.String),
});

/**
 * A collection subset. `limit` + `cursor` give cursor-based pagination:
 * "load more" widens the subset (re-register with a larger limit or a
 * cursor at the last row) rather than fetching detached pages.
 */
export type Subset = typeof SubsetSchema.Type;

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

// ─── Typed builder ─────────────────────────────────────────────────────────────
//
// A compile-time layer over the untyped `make`: field names and literal types
// are checked against a collection's row type, but the value erases to a plain
// `Subset` at runtime (the phantom `_row` is never present). The untyped
// surface stays the primitive — this is purely additive (ADR-0006).

/**
 * A {@link Subset} carrying its row type as a phantom. Erases to a plain
 * `Subset` at runtime; `_row` is never actually set. A `TypedSubset<A>` is a
 * `Subset` wherever one is expected, so it flows through the untyped protocol
 * surface unchanged while typed reads (`ClientEngine.query`/`observe`) refine
 * their result to `A`.
 */
export interface TypedSubset<A> extends Subset {
  readonly _row?: A;
}

/**
 * Field-checked predicate constructors for a row type `A`: each mirrors the
 * matching untyped constructor in {@link Predicate}, but the field must be a
 * key of `A` and the literal must match the field's type. Composition
 * (`and`/`or`/`not`) and `always` are passed through unchanged.
 */
export interface TypedPredicate<A> {
  eq<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  ne<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  gt<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  gte<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  lt<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  lte<K extends keyof A & string>(field: K, value: A[K]): Predicate.Predicate;
  in<K extends keyof A & string>(field: K, values: ReadonlyArray<A[K]>): Predicate.Predicate;
  and(...predicates: ReadonlyArray<Predicate.Predicate>): Predicate.Predicate;
  or(...predicates: ReadonlyArray<Predicate.Predicate>): Predicate.Predicate;
  not(predicate: Predicate.Predicate): Predicate.Predicate;
  readonly always: Predicate.Predicate;
}

/** One typed sort term: a field of the row type plus a direction. */
export interface TypedOrderBy<A> {
  readonly field: keyof A & string;
  readonly direction: Direction;
}

/** Options for {@link TypedSubsetBuilder.make}; mirrors the untyped `make`. */
export interface TypedSubsetOptions<A> {
  readonly where?: (p: TypedPredicate<A>) => Predicate.Predicate;
  readonly orderBy?: ReadonlyArray<TypedOrderBy<A>>;
  readonly limit?: number;
  readonly cursor?: string;
}

/** A subset builder bound to one collection's row type. */
export interface TypedSubsetBuilder<A> {
  readonly make: (options?: TypedSubsetOptions<A>) => TypedSubset<A>;
}

// The constructors are field-agnostic at runtime (the typing lives in the
// interface), so one shared implementation serves every row type.
const typedPredicate: TypedPredicate<unknown> = {
  eq: (field, value) => Predicate.eq(field, value as Predicate.Literal),
  ne: (field, value) => Predicate.ne(field, value as Predicate.Literal),
  gt: (field, value) => Predicate.gt(field, value as Predicate.Literal),
  gte: (field, value) => Predicate.gte(field, value as Predicate.Literal),
  lt: (field, value) => Predicate.lt(field, value as Predicate.Literal),
  lte: (field, value) => Predicate.lte(field, value as Predicate.Literal),
  in: (field, values) => Predicate.isIn(field, values as ReadonlyArray<Predicate.Literal>),
  and: (...predicates) => Predicate.and(...predicates),
  or: (...predicates) => Predicate.or(...predicates),
  not: (predicate) => Predicate.not(predicate),
  always: Predicate.always,
};

/**
 * Bind a subset builder to a collection: field names and literal types in
 * `where`/`orderBy` are then checked against the collection's row type. The
 * returned `make` just calls the untyped {@link make} and re-types the result
 * as a {@link TypedSubset}.
 *
 * `for` is a reserved word as a bare identifier, so the function is named
 * `forCollection` and re-exported as `for`; both are usable (`Subset.for` reads
 * best on the namespace import).
 */
export const forCollection = <C extends AnyCollection>(
  collection: C
): TypedSubsetBuilder<RowOf<C>> => ({
  make: (options) => {
    const where = options?.where?.(typedPredicate as TypedPredicate<RowOf<C>>);
    return make({
      collection: collection.name,
      ...(where !== undefined ? { where } : {}),
      ...(options?.orderBy !== undefined
        ? { orderBy: options.orderBy as ReadonlyArray<OrderBy> }
        : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
    }) as TypedSubset<RowOf<C>>;
  },
});

export { forCollection as for };

/** A `(id, value)` row — the unit subsets and live views operate over. */
export interface Row {
  readonly id: string;
  readonly value: unknown;
}

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;

/** Compare two field values ascending; null/undefined sort first. */
const compareValues = (left: unknown, right: unknown): number => {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return (left as number | string) < (right as number | string) ? -1 : 1;
};

/**
 * A total-order comparator over *rows* for an `orderBy`: `orderBy`'s fields
 * first, then row id ascending as a tie-break. The id tie-break is what
 * makes this a genuine total order even for an empty `orderBy` (every row
 * would otherwise tie) — `LiveView` relies on that to locate a delta's row
 * in O(log n) instead of scanning every same-key row (issue #112). Stable
 * across the same `orderBy`, so it can both sort a set from scratch
 * (`sortFiltered`) and place one row incrementally (`LiveView`).
 *
 * This is also **the collation seam**, and today it is a deliberate punt:
 * ordering is JS's default `<` over the field's decoded value (code-unit
 * order for strings, numeric for numbers) — no locale-aware collation, no
 * case-insensitive option. `Subset.apply` is the *sole* ordering authority
 * for both the server (every `Backend.evaluate` finalizes order/limit/cursor
 * locally with it — `MemoryBackend`, `@legation/sql`'s `SqlBackend`,
 * `@legation/jsonapi`'s `JsonApiBackend`) and the client (`LiveView`), so
 * client and server always agree on cursor windows *by construction* — but
 * only as long as this stays the one comparator both sides call. A
 * locale-aware collation therefore cannot be a client-local `observe`
 * option (a client sorting `"café" < "cafe"` while the server's cursor
 * assumes code-unit order would silently tear cursor pages); it would have
 * to be declared on the `Subset`/collection itself, wire-serialized, and
 * threaded into this comparator on both sides — the same shape as the
 * derivable-set declaration in ADR-0023. Nothing in this codebase needs
 * non-default collation yet, so that declaration is not added here; this
 * comment is the record the issue asked for. Adding it later is additive
 * (a new optional `Subset.collation` field defaulting to today's behavior).
 */
export const comparator =
  (orderBy: ReadonlyArray<OrderBy>) =>
  (a: Row, b: Row): number => {
    for (const term of orderBy) {
      const ordered = compareValues(fieldOf(a.value, term.field), fieldOf(b.value, term.field));
      if (ordered !== 0) return term.direction === "asc" ? ordered : -ordered;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

/** Filter rows by the subset's predicate and sort by its `orderBy` (no window). */
export const sortFiltered = <R extends Row>(
  rows: ReadonlyArray<R>,
  subset: Subset
): ReadonlyArray<R> => {
  const filtered = rows.filter((row) => Predicate.test(subset.where, row.value));
  return filtered.toSorted(comparator(subset.orderBy));
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

// ─── Indexed evaluation (issue #113) ─────────────────────────────────────────
//
// Same semantics as `sortFiltered`/`apply`, but over an id-keyed row map with
// an optional `Index.CollectionIndex` in front of the filter step: an
// indexable `where` resolves via `O(hits)` index lookups instead of testing
// every row. A predicate the index can't narrow (or no index at all) falls
// back to exactly today's full scan — this is additive, never a behavior
// change for unindexed paths.

const fullScan = <R extends Row>(
  rowsById: ReadonlyMap<string, R>,
  where: Predicate.Predicate
): Array<R> => {
  const result: Array<R> = [];
  for (const row of rowsById.values()) {
    if (Predicate.test(where, row.value)) result.push(row);
  }
  return result;
};

/** {@link sortFiltered}, but reading rows from an id-keyed map with optional index acceleration. */
export const sortFilteredIndexed = <R extends Row>(
  rowsById: ReadonlyMap<string, R>,
  subset: Subset,
  index?: Index.CollectionIndex
): ReadonlyArray<R> => {
  const filtered =
    (index !== undefined ? Index.evaluate(index, rowsById, subset.where) : undefined) ??
    fullScan(rowsById, subset.where);
  return filtered.toSorted(comparator(subset.orderBy));
};

/** {@link apply}, but reading rows from an id-keyed map with optional index acceleration. */
export const applyIndexed = <R extends Row>(
  rowsById: ReadonlyMap<string, R>,
  subset: Subset,
  index?: Index.CollectionIndex
): ReadonlyArray<R> => window(sortFilteredIndexed(rowsById, subset, index), subset);
