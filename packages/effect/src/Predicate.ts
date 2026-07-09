/**
 * Predicate
 *
 * The serializable expression language over row fields used by
 * subscriptions and live queries. Predicates are data (an expression tree),
 * not opaque functions, so they can travel over the wire, be narrowed by
 * server-side auth filters (AND-ed, never widened), be evaluated against
 * any storage, and later feed incremental view maintenance.
 *
 * Core ships an in-memory evaluator; storage-specific translators (e.g.
 * predicate → SQL WHERE clause) live with the backends that need them.
 */

import { Effect, Schema } from "effect";

/** A literal comparable value. */
export type Literal = string | number | boolean | null;

/** Comparison operators over a row field. */
export type Comparison = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/**
 * A predicate expression tree.
 *
 * - `True` matches every row (the empty predicate).
 * - `Compare` compares a top-level row field against a literal.
 * - `In` tests field membership in a literal set.
 * - `And` / `Or` / `Not` compose.
 * - `Exists` is a correlated relationship test: this row matches if a row
 *   exists in `collection` whose `where` holds and whose `foreignField` equals
 *   this row's `localField`. It is a relational node — a single-row evaluator
 *   can't decide it; a backend resolves it to an `In` over `localField` against
 *   the matching `foreignField` set (`resolveExists`).
 */
export type Predicate =
  | { readonly _tag: "True" }
  | {
      readonly _tag: "Compare";
      readonly op: Comparison;
      readonly field: string;
      readonly value: Literal;
    }
  | { readonly _tag: "In"; readonly field: string; readonly values: ReadonlyArray<Literal> }
  | { readonly _tag: "And"; readonly predicates: ReadonlyArray<Predicate> }
  | { readonly _tag: "Or"; readonly predicates: ReadonlyArray<Predicate> }
  | { readonly _tag: "Not"; readonly predicate: Predicate }
  | {
      readonly _tag: "Exists";
      readonly collection: string;
      readonly localField: string;
      readonly foreignField: string;
      readonly where: Predicate;
    };

/** The fields of an {@link Predicate} `Exists` node. */
export interface ExistsNode {
  readonly collection: string;
  readonly localField: string;
  readonly foreignField: string;
  readonly where: Predicate;
}

const LiteralSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

/** Wire codec for {@link Predicate}. */
export const PredicateSchema: Schema.Codec<Predicate> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("True") }),
  Schema.Struct({
    _tag: Schema.tag("Compare"),
    op: Schema.Literals(["eq", "ne", "gt", "gte", "lt", "lte"]),
    field: Schema.String,
    value: LiteralSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("In"),
    field: Schema.String,
    values: Schema.Array(LiteralSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("And"),
    predicates: Schema.Array(Schema.suspend((): Schema.Codec<Predicate> => PredicateSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("Or"),
    predicates: Schema.Array(Schema.suspend((): Schema.Codec<Predicate> => PredicateSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("Not"),
    predicate: Schema.suspend((): Schema.Codec<Predicate> => PredicateSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("Exists"),
    collection: Schema.String,
    localField: Schema.String,
    foreignField: Schema.String,
    where: Schema.suspend((): Schema.Codec<Predicate> => PredicateSchema),
  }),
]) as Schema.Codec<Predicate>;

// ─── Constructors ────────────────────────────────────────────────────────────

export const always: Predicate = { _tag: "True" };

export const compare = (op: Comparison, field: string, value: Literal): Predicate => ({
  _tag: "Compare",
  op,
  field,
  value,
});

export const eq = (field: string, value: Literal): Predicate => compare("eq", field, value);
export const ne = (field: string, value: Literal): Predicate => compare("ne", field, value);
export const gt = (field: string, value: Literal): Predicate => compare("gt", field, value);
export const gte = (field: string, value: Literal): Predicate => compare("gte", field, value);
export const lt = (field: string, value: Literal): Predicate => compare("lt", field, value);
export const lte = (field: string, value: Literal): Predicate => compare("lte", field, value);

export const isIn = (field: string, values: ReadonlyArray<Literal>): Predicate => ({
  _tag: "In",
  field,
  values,
});

export const and = (...predicates: ReadonlyArray<Predicate>): Predicate =>
  predicates.length === 1 ? predicates[0]! : { _tag: "And", predicates };

export const or = (...predicates: ReadonlyArray<Predicate>): Predicate =>
  predicates.length === 1 ? predicates[0]! : { _tag: "Or", predicates };

export const not = (predicate: Predicate): Predicate => ({ _tag: "Not", predicate });

/**
 * A correlated relationship test: this row matches if a row exists in
 * `collection` where `where` holds and `foreignField` equals this row's
 * `localField`. Resolved server-side by a backend (`resolveExists`).
 */
export const exists = (options: {
  readonly collection: string;
  readonly localField: string;
  readonly foreignField: string;
  readonly where?: Predicate;
}): Predicate => ({
  _tag: "Exists",
  collection: options.collection,
  localField: options.localField,
  foreignField: options.foreignField,
  where: options.where ?? always,
});

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Top-level field access on a row value: `undefined` for a non-object row or
 * an absent field, distinct from an explicit `null`. Exported so accelerated
 * evaluators (`Index.ts`) read fields with exactly this semantics — the
 * single source of truth `test` also uses.
 */
export const fieldValue = (row: unknown, field: string): unknown =>
  typeof row === "object" && row !== null ? (row as Record<string, unknown>)[field] : undefined;

const compareValues = (op: Comparison, left: unknown, right: Literal): boolean => {
  switch (op) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (
        (typeof left === "number" && typeof right === "number") ||
        (typeof left === "string" && typeof right === "string")
      ) {
        if (op === "gt") return left > right;
        if (op === "gte") return left >= right;
        if (op === "lt") return left < right;
        return left <= right;
      }
      return false;
    }
  }
};

/**
 * Evaluate a predicate against a row value (in-memory semantics: top-level
 * field access, strict equality, ordered comparisons on same-typed
 * string/number pairs only).
 *
 * `Exists` is relational and can't be decided from one row, so it evaluates to
 * `true` here: a backend resolves it to an `In` before evaluation
 * (`resolveExists`), and on the client the rows were already narrowed by the
 * server's authoritative sync.
 */
export const test = (predicate: Predicate, row: unknown): boolean => {
  switch (predicate._tag) {
    case "True":
      return true;
    case "Compare":
      return compareValues(predicate.op, fieldValue(row, predicate.field), predicate.value);
    case "In":
      return predicate.values.includes(fieldValue(row, predicate.field) as Literal);
    case "And":
      return predicate.predicates.every((p) => test(p, row));
    case "Or":
      return predicate.predicates.some((p) => test(p, row));
    case "Not":
      return !test(predicate.predicate, row);
    case "Exists":
      return true;
  }
};

/**
 * Rewrite every `Exists` node to an `In` over its `localField`, using `resolve`
 * to materialize the matching `foreignField` values from the related
 * collection. Backends call this before evaluation, turning a correlated join
 * into a flat, locally-evaluable predicate (an allow-set).
 */
export const resolveExists = <E, R>(
  predicate: Predicate,
  resolve: (node: ExistsNode) => Effect.Effect<ReadonlyArray<Literal>, E, R>
): Effect.Effect<Predicate, E, R> => {
  switch (predicate._tag) {
    case "Exists":
      return resolve(predicate).pipe(Effect.map((values) => isIn(predicate.localField, values)));
    case "And":
      return Effect.forEach(predicate.predicates, (p) => resolveExists(p, resolve)).pipe(
        Effect.map((predicates) => and(...predicates))
      );
    case "Or":
      return Effect.forEach(predicate.predicates, (p) => resolveExists(p, resolve)).pipe(
        Effect.map((predicates) => or(...predicates))
      );
    case "Not":
      return resolveExists(predicate.predicate, resolve).pipe(Effect.map(not));
    default:
      return Effect.succeed(predicate);
  }
};

/** The distinct `foreignField` values among rows matching an Exists `where`. */
export const existsValues = (node: ExistsNode, rows: Iterable<unknown>): ReadonlyArray<Literal> => {
  const values = new Set<Literal>();
  for (const row of rows) {
    if (test(node.where, row)) values.add(fieldValue(row, node.foreignField) as Literal);
  }
  return [...values];
};

/** Whether a predicate contains any (unresolved) `Exists` node. */
export const hasExists = (predicate: Predicate): boolean => {
  switch (predicate._tag) {
    case "Exists":
      return true;
    case "And":
    case "Or":
      return predicate.predicates.some(hasExists);
    case "Not":
      return hasExists(predicate.predicate);
    default:
      return false;
  }
};
