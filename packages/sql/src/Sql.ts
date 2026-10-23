/**
 * Sql
 *
 * Translate a `Subset`'s predicate into a parameterised SQL `WHERE` clause.
 * The translation is pure and dialect-aware (placeholder, identifier quoting,
 * collation name, boolean encoding), and it is **exact**: every node compiles
 * to a SQL boolean expression whose three-valued result on a row equals
 * `Predicate.evaluate` on that row (ADR-0028 §6), so the `WHERE` returns
 * precisely the rows the JS evaluator returns `Some(true)` for — on Postgres
 * (normative) and on SQLite alike. The differential harness
 * (`__tests__/differential.test.ts`, issue #153) proves it against a real
 * Postgres and SQLite over the generated corpus, set and per-row verdict
 * both. The `SqlBackend` still finalises order/limit/cursor locally with
 * `Subset.apply`; that is redundancy, not correction.
 *
 * Predicate → SQL:
 * - `True` → `1 = 1`
 * - `Compare` → `col <op> ?`; a `null` literal binds as `NULL`, so the
 *   comparison is unknown for every row — exactly `Predicate.evaluate`
 *   (ADR-0028 §5). `IS NULL` is the `IsNull` node, which
 *   `Predicate.eq(f, null)` desugars to.
 * - `In` → `col IN (?, ?, …)` (empty set → `1 = 0`)
 * - `NotIn` → `col NOT IN (?, ?, …)` (empty set → `1 = 1`)
 * - `IsNull` → `col IS NULL` / `col IS NOT NULL`
 * - `And` / `Or` → parenthesised joins (empty And → `1 = 1`, empty Or → `1 = 0`)
 * - `Not` → `NOT (…)`
 * - `Exists` → `localField IN (SELECT foreignField FROM collection WHERE …)`
 *
 * **Literal kinds (`kinds` option).** `compileWhere` and `compileSelect`
 * accept a field → `Predicate.LiteralKind` map (`text`, `integer`, `double`,
 * `boolean`, `instant`), the per-attribute declaration of ADR-0028 §4. It
 * drives two things:
 *
 * - **The collation clause.** A `Compare`, `In` or `NotIn` on a field
 *   declared `text` carries an explicit code-point collation on the column
 *   side — `"col" COLLATE "C"` on Postgres, `"col" COLLATE BINARY` on
 *   SQLite — so text orders by code point even where the column's own
 *   collation is not `"C"`. The clause is emitted for a declared `text`
 *   field only, never inferred from a string literal: a string may be bound
 *   against a `uuid`, `date`, enum or `timestamptz` column, none of which
 *   accepts a collation, and an `instant` compares chronologically without
 *   one. A field without a declaration compiles to a plain comparison and
 *   orders by the column's own collation — hence the schema rule, which
 *   stands regardless: filterable and sortable text columns are declared
 *   `COLLATE "C"` (Postgres) or left at `BINARY` (SQLite). Nothing checks
 *   DDL.
 * - **Typed binds (rule (d)).** A literal of the declared kind's JS type
 *   binds as that type: strings for `text` and `instant`, numbers for
 *   `integer` and `double` (SQLite stores an integral number as INTEGER and
 *   the rest as REAL; a Postgres driver sends text the server infers against
 *   the column), and booleans as the dialect stores them (Postgres
 *   `true`/`false`, SQLite `1`/`0`). A literal of another JS type is a
 *   cross-type comparison, which the grammar cannot express and the sync
 *   tier rejects; the compiler gives it `Predicate.evaluate`'s verdict —
 *   unknown — by binding `NULL` in its place, so SQLite's affinity coercion
 *   (`1 = '1'`) never sees the raw literal. In an `In`/`NotIn` list such
 *   literals are dropped (a mismatch can match nothing), and a non-empty
 *   list left with no literal binds one `NULL`, which is unknown.
 *
 * Without a declaration a literal binds as its JS type (booleans still per
 * dialect) and nothing collates. The inner `where` of an `Exists` names the
 * foreign collection's fields, so it takes that collection's entry in
 * `foreignKinds` (collection → kinds); `SqlBackend` passes every mapping's
 * kinds through.
 */

import type { Predicate } from "@thomasfosterau/legation-effect";
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";

/** A SQL fragment plus its ordered bind parameters. */
export interface SqlFragment {
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
}

/** Placeholder, identifier-quoting, collation and boolean rules for a SQL dialect. */
export interface Dialect {
  /** Bind placeholder for the 1-based parameter index. */
  readonly placeholder: (index: number) => string;
  /** Quote a column/table identifier. */
  readonly quote: (identifier: string) => string;
  /** The code-point collation name, emitted as `COLLATE <name>` after a declared-text operand. */
  readonly textCollation: string;
  /** How a boolean literal binds (Postgres has booleans; SQLite stores `0`/`1`). */
  readonly boolean: (value: boolean) => unknown;
  /** The larger of two SQL expressions: `MAX` on SQLite, `GREATEST` on PostgreSQL. */
  readonly greatest: (left: string, right: string) => string;
  /**
   * The statement that makes the transaction it runs in SERIALIZABLE, run first
   * in each `applyMutations` transaction (#353). It must be the transaction's first
   * statement in a top-level transaction: a nested one refuses it, and the batch
   * then fails. Absent on a dialect whose writers already serialise (SQLite takes
   * its write lock with `BEGIN IMMEDIATE`); a hand-written dialect without it gets
   * no isolation statement, so its executor must provide the isolation itself.
   */
  readonly serializable?: string | undefined;
}

/** Field → literal kind, for the collation clause and typed binds. */
export type Kinds = Readonly<Record<string, Predicate.LiteralKind>>;

/** Options shared by {@link compileWhere} and {@link compileSelect}. */
export interface CompileOptions {
  /** Declared literal kinds of the predicate's own fields (see the module doc). */
  readonly kinds?: Kinds | undefined;
  /** Declared kinds of other collections' fields, keyed by collection, for the inner `where` of an `Exists`. */
  readonly foreignKinds?: Readonly<Record<string, Kinds>> | undefined;
}

const quoteDouble = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/** SQLite: `?` placeholders, `COLLATE BINARY`, booleans as `0`/`1`. */
export const sqlite: Dialect = {
  placeholder: () => "?",
  quote: quoteDouble,
  textCollation: "BINARY",
  boolean: (value) => (value ? 1 : 0),
  greatest: (left, right) => `MAX(${left}, ${right})`,
};

/** PostgreSQL: `$1`, `$2`, … placeholders, `COLLATE "C"`, native booleans, SERIALIZABLE transactions. */
export const postgres: Dialect = {
  placeholder: (index) => `$${index}`,
  quote: quoteDouble,
  textCollation: `"C"`,
  boolean: (value) => value,
  greatest: (left, right) => `GREATEST(${left}, ${right})`,
  serializable: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
};

const comparators: Record<Predicate.Comparison, string> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** Accumulates bind params so placeholders get the right 1-based index. */
class Params {
  readonly values: Array<unknown> = [];
  constructor(private readonly dialect: Dialect) {}
  bind(value: unknown): string {
    this.values.push(value);
    return this.dialect.placeholder(this.values.length);
  }
}

/** One compilation's context: the dialect, the bind accumulator and the declared kinds. */
interface Compilation {
  readonly dialect: Dialect;
  readonly params: Params;
  readonly kinds: Kinds | undefined;
  readonly foreignKinds: Readonly<Record<string, Kinds>> | undefined;
}

/** The JS type a literal of each kind has. */
const jsTypeOf: Record<Predicate.LiteralKind, "string" | "number" | "boolean"> = {
  text: "string",
  instant: "string",
  integer: "number",
  double: "number",
  boolean: "boolean",
};

/** Whether a literal can bind as the declared kind: `null` always, else by JS type. */
const conforms = (kind: Predicate.LiteralKind | undefined, value: Predicate.Literal): boolean =>
  value === null || kind === undefined || typeof value === jsTypeOf[kind];

/** The column operand: quoted, with the collation clause when declared `text`. */
const operand = (compilation: Compilation, field: string): string => {
  const column = compilation.dialect.quote(field);
  return compilation.kinds?.[field] === "text"
    ? `${column} COLLATE ${compilation.dialect.textCollation}`
    : column;
};

/**
 * Bind one literal under the field's declared kind: a conforming literal as
 * itself (booleans as the dialect stores them), a cross-type literal as
 * `NULL` (unknown, rule (d)).
 */
const bindLiteral = (compilation: Compilation, field: string, value: Predicate.Literal): string => {
  const { params, dialect, kinds } = compilation;
  if (!conforms(kinds?.[field], value)) return params.bind(null);
  return params.bind(P.isBoolean(value) ? dialect.boolean(value) : value);
};

/**
 * The literals of an `In`/`NotIn` list that can bind under the declared
 * kind. A cross-type literal matches nothing, so it is dropped; a non-empty
 * list left with nothing binds one `NULL`, which makes the membership
 * unknown — `Predicate.evaluate`'s verdict when no listed literal has the
 * field's type.
 */
const bindableList = (
  compilation: Compilation,
  field: string,
  values: ReadonlyArray<Predicate.Literal>
): ReadonlyArray<Predicate.Literal> => {
  const kind = compilation.kinds?.[field];
  const kept = values.filter((value) => conforms(kind, value));
  return Arr.isReadonlyArrayEmpty(kept) ? [null] : kept;
};

type CompareNode = Extract<Predicate.Predicate, { readonly _tag: "Compare" }>;
type ListNode = Extract<Predicate.Predicate, { readonly _tag: "In" | "NotIn" }>;
type ExistsNode = Extract<Predicate.Predicate, { readonly _tag: "Exists" }>;

const compileCompare = (node: CompareNode, compilation: Compilation): string =>
  `${operand(compilation, node.field)} ${comparators[node.op]} ${bindLiteral(compilation, node.field, node.value)}`;

/** `In` / `NotIn`: an empty list is the constant `FALSE` / `TRUE` (ADR-0028 §3). */
const compileList = (node: ListNode, compilation: Compilation): string => {
  if (Arr.isReadonlyArrayEmpty(node.values)) return node._tag === "In" ? "1 = 0" : "1 = 1";
  const placeholders = bindableList(compilation, node.field, node.values)
    .map((value) => bindLiteral(compilation, node.field, value))
    .join(", ");
  return `${operand(compilation, node.field)} ${node._tag === "In" ? "IN" : "NOT IN"} (${placeholders})`;
};

/** Correlated set membership: `localField IN (SELECT foreignField FROM … WHERE …)`. */
const compileExists = (node: ExistsNode, compilation: Compilation): string => {
  // The inner `where` names the foreign collection's fields: its kinds come
  // from `foreignKinds`, never from the outer collection's `kinds`.
  const kinds = compilation.foreignKinds?.[node.collection];
  const inner = compileNode(node.where, { ...compilation, kinds });
  const { quote } = compilation.dialect;
  return `${quote(node.localField)} IN (SELECT ${quote(node.foreignField)} FROM ${quote(node.collection)} WHERE ${inner})`;
};

const compileNode = (predicate: Predicate.Predicate, compilation: Compilation): string => {
  switch (predicate._tag) {
    case "True":
      return "1 = 1";
    case "Compare":
      return compileCompare(predicate, compilation);
    case "In":
    case "NotIn":
      return compileList(predicate, compilation);
    case "IsNull":
      return `${compilation.dialect.quote(predicate.field)} IS ${predicate.negated === true ? "NOT " : ""}NULL`;
    case "And":
      if (Arr.isReadonlyArrayEmpty(predicate.predicates)) return "1 = 1";
      return predicate.predicates.map((inner) => compileNode(inner, compilation)).join(" AND ");
    case "Or": {
      if (Arr.isReadonlyArrayEmpty(predicate.predicates)) return "1 = 0";
      return `(${predicate.predicates.map((inner) => compileNode(inner, compilation)).join(" OR ")})`;
    }
    case "Not":
      return `NOT (${compileNode(predicate.predicate, compilation)})`;
    case "Exists":
      return compileExists(predicate, compilation);
  }
};

/**
 * Compile a predicate into a `WHERE`-ready fragment for a dialect. Pass
 * `options.kinds` (field → literal kind) so declared-text fields get their
 * collation clause and literals bind by the declared kind; without a
 * declaration nothing collates and a literal binds as its JS type (see the
 * module doc).
 */
export const compileWhere = (
  predicate: Predicate.Predicate,
  dialect: Dialect = sqlite,
  options: CompileOptions = {}
): SqlFragment => {
  const params = new Params(dialect);
  const text = compileNode(predicate, {
    dialect,
    params,
    kinds: options.kinds,
    foreignKinds: options.foreignKinds,
  });
  return { text, params: params.values };
};

/**
 * Compile a `SELECT * FROM <table> WHERE <predicate>` for a subset. The
 * `WHERE` is exact (see the module doc). Order, limit and cursor are not
 * pushed down: this statement may later grow an `ORDER BY … LIMIT` for
 * backends that want it, but today the backend's `Subset.apply` finalises
 * them locally, so this stays a single, safe statement.
 */
export const compileSelect = (
  options: {
    readonly table: string;
    readonly where: Predicate.Predicate;
    readonly dialect?: Dialect;
  } & CompileOptions
): SqlFragment => {
  const dialect = options.dialect ?? sqlite;
  const { text, params } = compileWhere(options.where, dialect, {
    kinds: options.kinds,
    foreignKinds: options.foreignKinds,
  });
  return { text: `SELECT * FROM ${dialect.quote(options.table)} WHERE ${text}`, params };
};
