/**
 * Predicate
 *
 * The serializable expression language over row fields used by
 * subscriptions and live queries. Predicates are data (an expression tree),
 * not opaque functions, so they can travel over the wire, be narrowed by
 * server-side auth filters (AND-ed, never widened), be evaluated against
 * any storage, and later feed incremental view maintenance.
 *
 * Semantics are Postgres's, per ADR-0028 (`docs/adr/0028-filter-grammar-
 * and-normative-semantics.md`): `evaluate` is three-valued (`Option<boolean>`
 * with Kleene connectives), an absent attribute is NULL, text orders by code
 * point, and a `Compare`/`In` against a `null` literal is unknown. `test` is
 * the `WHERE` collapse of `evaluate`: a row matches iff the result is
 * `Some(true)`. The differential harness in `@thomasfosterau/legation-sql` proves every
 * evaluator agrees with a real Postgres.
 *
 * Core ships this in-memory evaluator; storage-specific translators (e.g.
 * predicate → SQL WHERE clause) live with the backends that need them.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * A literal comparable value. `null` stays in the wire union for
 * compatibility; under ADR-0028 NULL is not a literal (use `IsNull`), and a
 * `Compare`/`In` carrying `null` evaluates to unknown, as in Postgres.
 */
export type Literal = string | number | boolean | null;

/** Comparison operators over a row field. */
export type Comparison = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/**
 * The literal kinds of ADR-0028 rule (e): `text` (code-point ordered),
 * `integer` (int4), `double` (double precision), `boolean`, and `instant`
 * (an ISO-8601 UTC string in the fixed `Date#toISOString` format, so text
 * order is chronological order). A declared attribute carries one of these;
 * the SQL compilers bind and collate by it (`@thomasfosterau/legation-sql`), and the
 * differential corpus (`FilterCorpus`) generates literals of it.
 */
export type LiteralKind = "text" | "integer" | "double" | "boolean" | "instant";

/**
 * A predicate expression tree.
 *
 * - `True` matches every row (the empty predicate).
 * - `Compare` compares a top-level row field against a literal.
 * - `In` tests field membership in a literal set; `NotIn` is its SQL
 *   `NOT IN` (`x <> a AND x <> b`), not the Kleene negation of `In`.
 * - `IsNull` is the only way to test for NULL (an absent field is NULL too);
 *   `negated` makes it `IS NOT NULL`.
 * - `And` / `Or` / `Not` compose (Kleene connectives).
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
  | { readonly _tag: "NotIn"; readonly field: string; readonly values: ReadonlyArray<Literal> }
  | { readonly _tag: "IsNull"; readonly field: string; readonly negated?: boolean }
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

/**
 * Wire codec for {@link Predicate}. `NotIn` and `IsNull` were added by
 * ADR-0028 (wire-additive: every older encoding still decodes).
 */
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
    _tag: Schema.tag("NotIn"),
    field: Schema.String,
    values: Schema.Array(LiteralSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("IsNull"),
    field: Schema.String,
    negated: Schema.optional(Schema.Boolean),
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

/** The predicate every row matches. */
export const always: Predicate = { _tag: "True" };

/**
 * The raw `Compare` node. Prefer the named constructors: `eq`/`ne` desugar
 * a `null` literal to `IsNull`, whereas a `Compare` built here with `null`
 * evaluates to unknown for every row (ADR-0028 section 5).
 */
export const compare = (op: Comparison, field: string, value: Literal): Predicate => ({
  _tag: "Compare",
  op,
  field,
  value,
});

/** `field IS NULL` — true for an explicit `null` and for an absent field alike. */
export const isNull = (field: string): Predicate => ({ _tag: "IsNull", field });

/** `field IS NOT NULL`. */
export const isNotNull = (field: string): Predicate => ({ _tag: "IsNull", field, negated: true });

/** `field = value`; `eq(field, null)` desugars to {@link isNull} (ADR-0028). */
export const eq = (field: string, value: Literal): Predicate =>
  value === null ? isNull(field) : compare("eq", field, value);
/** `field <> value`; `ne(field, null)` desugars to {@link isNotNull} (ADR-0028). */
export const ne = (field: string, value: Literal): Predicate =>
  value === null ? isNotNull(field) : compare("ne", field, value);
/** `field > value`; unknown when the field is null or absent (three-valued, ADR-0028). */
export const gt = (field: string, value: Literal): Predicate => compare("gt", field, value);
/** `field >= value`; unknown when the field is null or absent (three-valued, ADR-0028). */
export const gte = (field: string, value: Literal): Predicate => compare("gte", field, value);
/** `field < value`; unknown when the field is null or absent (three-valued, ADR-0028). */
export const lt = (field: string, value: Literal): Predicate => compare("lt", field, value);
/** `field <= value`; unknown when the field is null or absent (three-valued, ADR-0028). */
export const lte = (field: string, value: Literal): Predicate => compare("lte", field, value);

/** `field IN (values)`: unknown on a NULL or absent field; an empty list matches no row. */
export const isIn = (field: string, values: ReadonlyArray<Literal>): Predicate => ({
  _tag: "In",
  field,
  values,
});

/** `field NOT IN (values)`: SQL's `x <> a AND x <> b`, unknown on a NULL field. */
export const notIn = (field: string, values: ReadonlyArray<Literal>): Predicate => ({
  _tag: "NotIn",
  field,
  values,
});

/** Conjunction (three-valued); a single predicate is returned unchanged. */
export const and = (...predicates: ReadonlyArray<Predicate>): Predicate =>
  predicates.length === 1 ? predicates[0]! : { _tag: "And", predicates };

/** Disjunction (three-valued); a single predicate is returned unchanged. */
export const or = (...predicates: ReadonlyArray<Predicate>): Predicate =>
  predicates.length === 1 ? predicates[0]! : { _tag: "Or", predicates };

/** Negation (three-valued: `not` of unknown stays unknown). */
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

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Compare two strings by Unicode code point (ADR-0028 rule (c)): the order
 * of Postgres `COLLATE "C"` (UTF-8 bytes) and SQLite `BINARY`. JS `<`
 * compares UTF-16 code units, which diverges only where an astral character
 * (a surrogate pair, U+10000 and above) meets U+E000–U+FFFF. Walks the two
 * strings code point by code point without allocating; a lone surrogate
 * compares as its own code unit, exactly like iterating `Array.from(s)`.
 */
export const compareText = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : i < b.length ? -1 : 0;
};

/**
 * Order two same-typed literals: numbers numerically, text by code point,
 * booleans `false < true` (ADR-0028 section 3). `undefined` when the operands
 * are not of one comparable type — the "type mismatch" of rule (d).
 */
export const compareLiterals = (left: unknown, right: unknown): number | undefined => {
  if (typeof left !== typeof right) return undefined;
  switch (typeof left) {
    case "number":
      return numericOrder(left, right as number);
    case "string":
      return compareText(left, right as string);
    case "boolean":
      return numericOrder(Number(left), Number(right));
    default:
      return undefined;
  }
};

const numericOrder = (left: number, right: number): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Whether a comparison operator holds for an ordering result (`-1`, `0`,
 * `1`) from {@link compareLiterals}: the per-operator table of ADR-0028
 * section 3 in one place, shared by `evaluate` and `CollectionIndex`.
 */
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

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Top-level field access on a row value: `undefined` for a non-object row or
 * an absent field, `null` for an explicit null. Evaluation treats the two
 * alike (ADR-0028 rule (b): absent ≡ NULL); accelerated evaluators
 * (`CollectionIndex.ts`) read fields with exactly this function so they bucket
 * the same way `evaluate` does.
 */
// oxlint-disable-next-line effect/no-unknown-returns -- exported on the package root; a row's field is untyped JSON, and `undefined`/`null`/any literal are all meaningful results.
export const fieldValue = (row: unknown, field: string): unknown =>
  P.isObjectOrArray(row) ? (row as Record<string, unknown>)[field] : undefined;

/** Whether a field value is NULL for evaluation: an explicit `null` or absent. */
export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const TRUE: Option.Option<boolean> = Option.some(true);
const FALSE: Option.Option<boolean> = Option.some(false);
const UNKNOWN: Option.Option<boolean> = Option.none();

const definite = (value: boolean): Option.Option<boolean> => (value ? TRUE : FALSE);

type CompareNode = Extract<Predicate, { readonly _tag: "Compare" }>;

/** `Compare`: unknown on a NULL field, a `null` literal or a type mismatch; else the operator. */
const evaluateCompare = (predicate: CompareNode, row: unknown): Option.Option<boolean> => {
  const left = fieldValue(row, predicate.field);
  if (isNullish(left) || predicate.value === null) return UNKNOWN;
  const ordered = compareLiterals(left, predicate.value);
  return ordered === undefined ? UNKNOWN : definite(holds(predicate.op, ordered));
};

/**
 * `In` / `NotIn` over a present field and a non-empty list: `Some(onMatch)`
 * on a match; unknown when no listed literal matches and one of them is
 * `null`, or when no listed literal has the field's type (rule (d), so
 * `Not(In)` and `Not(eq)` agree on a mismatch); else `Some(!onMatch)`.
 */
const membership = (
  left: unknown,
  values: ReadonlyArray<Literal>,
  onMatch: boolean
): Option.Option<boolean> => {
  if (values.includes(left as Literal)) return definite(onMatch);
  if (values.includes(null)) return UNKNOWN;
  if (!values.some((value) => compareLiterals(left, value) !== undefined)) return UNKNOWN;
  return definite(!onMatch);
};

/**
 * `In` (`onMatch` true) / `NotIn` (`onMatch` false). An empty list is
 * definite before the field is even read: SQL has no `x IN ()`, and the
 * compilers render it as `1 = 0` / `1 = 1`, which is false / true for a NULL
 * row too. The harness pins this.
 */
const evaluateMembership = (
  field: string,
  values: ReadonlyArray<Literal>,
  onMatch: boolean,
  row: unknown
): Option.Option<boolean> => {
  if (values.length === 0) return definite(!onMatch);
  const left = fieldValue(row, field);
  return isNullish(left) ? UNKNOWN : membership(left, values, onMatch);
};

/** Kleene `And`: `Some(false)` if any operand is, else unknown if any is, else `Some(true)`. */
const evaluateAnd = (
  predicates: ReadonlyArray<Predicate>,
  row: unknown
): Option.Option<boolean> => {
  let unknown = false;
  for (const inner of predicates) {
    const result = evaluate(inner, row);
    if (Option.isNone(result)) unknown = true;
    else if (!result.value) return FALSE;
  }
  return unknown ? UNKNOWN : TRUE;
};

/** Kleene `Or`: `Some(true)` if any operand is, else unknown if any is, else `Some(false)`. */
const evaluateOr = (predicates: ReadonlyArray<Predicate>, row: unknown): Option.Option<boolean> => {
  let unknown = false;
  for (const inner of predicates) {
    const result = evaluate(inner, row);
    if (Option.isNone(result)) unknown = true;
    else if (result.value) return TRUE;
  }
  return unknown ? UNKNOWN : FALSE;
};

/** Kleene `Not`, over the shared constants rather than `Option.map`: no allocation per row. */
const negate = (inner: Option.Option<boolean>): Option.Option<boolean> =>
  Option.isNone(inner) ? UNKNOWN : inner.value ? FALSE : TRUE;

/**
 * Evaluate a predicate against a row value under Postgres's three-valued
 * semantics (ADR-0028 section 3). `Some(true)` / `Some(false)` are definite;
 * `None` is unknown (a NULL got involved). Per node:
 *
 * - `True` → `Some(true)`.
 * - `Compare` → unknown if the field is NULL/absent or the literal is `null`;
 *   else the comparison over same-typed operands (numbers numerically, text
 *   by code point, booleans `false < true`); a type mismatch is unknown.
 * - `In` → `Some(false)` on an empty list (definite even for a NULL field:
 *   the compilers render it `1 = 0`); else unknown if the field is NULL;
 *   `Some(true)` on a match; unknown if no match and a listed literal is
 *   `null` or none has the field's type; else `Some(false)`.
 * - `NotIn` → the same with `true`/`false` swapped (`x <> a AND x <> b`;
 *   empty list `Some(true)`, `1 = 1`).
 * - `IsNull` → always definite: `Some(field is NULL)`, flipped by `negated`.
 * - `And` / `Or` / `Not` → Kleene's tables, written by hand: `And` is
 *   `Some(false)` if any operand is, else unknown if any operand is, else
 *   `Some(true)`; `Or` is the dual; `Not` maps over the option. Deliberately
 *   not `Option.all`/`zipWith`, which would make unknown absorbing.
 * - `Exists` → `Some(true)`. It is relational and can't be decided from one
 *   row: a backend resolves it to an `In` before evaluation (`resolveExists`),
 *   and on the client the rows were already narrowed by the server.
 */
export const evaluate = (predicate: Predicate, row: unknown): Option.Option<boolean> => {
  switch (predicate._tag) {
    case "True":
    case "Exists":
      return TRUE;
    case "Compare":
      return evaluateCompare(predicate, row);
    case "In":
      return evaluateMembership(predicate.field, predicate.values, true, row);
    case "NotIn":
      return evaluateMembership(predicate.field, predicate.values, false, row);
    case "IsNull":
      return definite(isNullish(fieldValue(row, predicate.field)) !== (predicate.negated === true));
    case "And":
      return evaluateAnd(predicate.predicates, row);
    case "Or":
      return evaluateOr(predicate.predicates, row);
    case "Not":
      return negate(evaluate(predicate.predicate, row));
  }
};

/**
 * Whether a row satisfies a predicate: the SQL `WHERE` collapse of
 * {@link evaluate} — `true` iff the result is `Some(true)`, so an unknown
 * (a NULL or absent field under `ne`, `NotIn`, `Not(eq)`, …) never matches.
 */
export const test = (predicate: Predicate, row: unknown): boolean =>
  Option.getOrElse(evaluate(predicate, row), () => false);

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
    case "True":
    case "Compare":
    case "In":
    case "NotIn":
    case "IsNull":
      return Effect.succeed(predicate);
  }
};

/**
 * The distinct `foreignField` values among rows matching an Exists `where`.
 * NULL and absent values are left out: NULL equals nothing, so a related row
 * without the field can never satisfy the correlation (ADR-0028 rule (b)).
 */
export const existsValues = (node: ExistsNode, rows: Iterable<unknown>): ReadonlyArray<Literal> => {
  const values = new Set<Literal>();
  for (const row of rows) {
    if (!test(node.where, row)) continue;
    const value = fieldValue(row, node.foreignField);
    if (!isNullish(value)) values.add(value as Literal);
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
    case "True":
    case "Compare":
    case "In":
    case "NotIn":
    case "IsNull":
      return false;
  }
};
