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
 * **Collation clause (ADR-0028 §4).** Every text comparison carries an
 * explicit code-point collation on the column side — `"col" COLLATE "C"` on
 * Postgres, `"col" COLLATE BINARY` on SQLite — for `Compare`, `In` and
 * `NotIn`, so text orders by code point even where the column's own
 * collation is not `"C"`. The schema rule stands regardless: filterable and
 * sortable text columns should be declared `COLLATE "C"` (Postgres) or left
 * at `BINARY` (SQLite) so the clause costs no index use; nothing checks DDL.
 *
 * **Literal kinds (`kinds` option).** The compiler cannot tell a text
 * attribute from an instant by the JS literal alone, so `compileWhere` and
 * `compileSelect` accept a field → `Predicate.LiteralKind` map. With a kind:
 * `text` gets the collation clause and binds as a string; `instant` gets no
 * clause (a `timestamptz` column rejects one, and a `text` instant column
 * compares chronologically by code point already) and binds as a string;
 * `integer` and `double` bind as JS numbers (SQLite stores an integral
 * number as INTEGER and the rest as REAL; a Postgres driver sends text the
 * server infers against the column); `boolean` binds as the dialect's
 * boolean (Postgres `true`/`false`, SQLite `1`/`0`). Without a kind the
 * fallback is the JS type of the literal: a string is treated as `text`
 * (collation emitted — declare `instant` to suppress it), a number as a
 * number, a boolean per dialect. Inside an `Exists` subquery the inner
 * `where` names the foreign collection's fields, so it compiles under the
 * fallback; `SqlBackend` resolves `Exists` before compiling and passes the
 * foreign table's own `kinds`.
 */

import type { Predicate } from "@legation/effect";

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
  /** The code-point collation name, emitted as `COLLATE <name>` after a text operand. */
  readonly textCollation: string;
  /** How a boolean literal binds (Postgres has booleans; SQLite stores `0`/`1`). */
  readonly boolean: (value: boolean) => unknown;
}

/** Field → literal kind, for the collation clause and typed binds. */
export type Kinds = Readonly<Record<string, Predicate.LiteralKind>>;

/** Options shared by {@link compileWhere} and {@link compileSelect}. */
export interface CompileOptions {
  /** Declared literal kinds of the predicate's fields; a field without one uses the literal-type fallback. */
  readonly kinds?: Kinds | undefined;
}

const quoteDouble = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/** SQLite: `?` placeholders, `COLLATE BINARY`, booleans as `0`/`1`. */
export const sqlite: Dialect = {
  placeholder: () => "?",
  quote: quoteDouble,
  textCollation: "BINARY",
  boolean: (value) => (value ? 1 : 0),
};

/** PostgreSQL: `$1`, `$2`, … placeholders, `COLLATE "C"`, native booleans. */
export const postgres: Dialect = {
  placeholder: (index) => `$${index}`,
  quote: quoteDouble,
  textCollation: `"C"`,
  boolean: (value) => value,
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
}

/** The literal-type fallback for a field without a declared kind. */
const fallbackKind = (
  values: ReadonlyArray<Predicate.Literal>
): Predicate.LiteralKind | undefined => {
  const sample = values.find((value) => value !== null);
  switch (typeof sample) {
    case "string":
      return "text";
    case "number":
      return Number.isInteger(sample) ? "integer" : "double";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
};

/** The kind a field's operand compiles under: the declared kind, else the literal-type fallback. */
const kindOf = (
  compilation: Compilation,
  field: string,
  values: ReadonlyArray<Predicate.Literal>
): Predicate.LiteralKind | undefined => compilation.kinds?.[field] ?? fallbackKind(values);

/** The column operand: quoted, with the collation clause for `text`. */
const operand = (
  compilation: Compilation,
  field: string,
  kind: Predicate.LiteralKind | undefined
) => {
  const column = compilation.dialect.quote(field);
  return kind === "text" ? `${column} COLLATE ${compilation.dialect.textCollation}` : column;
};

/**
 * Bind one literal as the dialect stores its kind. Only booleans need
 * encoding (SQLite has none); strings and numbers bind as they are and
 * `null` binds as `NULL`. The literal's own type decides, so a boolean never
 * reaches a driver that refuses it even when the declared kind disagrees.
 */
const bindLiteral = (compilation: Compilation, value: Predicate.Literal): string =>
  compilation.params.bind(typeof value === "boolean" ? compilation.dialect.boolean(value) : value);

type CompareNode = Extract<Predicate.Predicate, { readonly _tag: "Compare" }>;
type ListNode = Extract<Predicate.Predicate, { readonly _tag: "In" | "NotIn" }>;
type ExistsNode = Extract<Predicate.Predicate, { readonly _tag: "Exists" }>;

const compileCompare = (node: CompareNode, compilation: Compilation): string => {
  const kind = kindOf(compilation, node.field, [node.value]);
  const column = operand(compilation, node.field, kind);
  return `${column} ${comparators[node.op]} ${bindLiteral(compilation, node.value)}`;
};

/** `In` / `NotIn`: an empty list is the constant `FALSE` / `TRUE` (ADR-0028 §3). */
const compileList = (node: ListNode, compilation: Compilation): string => {
  if (node.values.length === 0) return node._tag === "In" ? "1 = 0" : "1 = 1";
  const kind = kindOf(compilation, node.field, node.values);
  const column = operand(compilation, node.field, kind);
  const placeholders = node.values.map((value) => bindLiteral(compilation, value)).join(", ");
  return `${column} ${node._tag === "In" ? "IN" : "NOT IN"} (${placeholders})`;
};

/** Correlated set membership: `localField IN (SELECT foreignField FROM … WHERE …)`. */
const compileExists = (node: ExistsNode, compilation: Compilation): string => {
  // The inner `where` names the foreign collection's fields, so the outer
  // `kinds` do not apply; it compiles under the literal-type fallback.
  const inner = compileNode(node.where, { ...compilation, kinds: undefined });
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
      if (predicate.predicates.length === 0) return "1 = 1";
      return predicate.predicates.map((inner) => compileNode(inner, compilation)).join(" AND ");
    case "Or": {
      if (predicate.predicates.length === 0) return "1 = 0";
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
 * `options.kinds` (field → literal kind) so text gets its collation clause,
 * instants do not, and booleans bind per dialect; without it the literal's
 * JS type decides (see the module doc).
 */
export const compileWhere = (
  predicate: Predicate.Predicate,
  dialect: Dialect = sqlite,
  options: CompileOptions = {}
): SqlFragment => {
  const params = new Params(dialect);
  const text = compileNode(predicate, { dialect, params, kinds: options.kinds });
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
  const { text, params } = compileWhere(options.where, dialect, { kinds: options.kinds });
  return { text: `SELECT * FROM ${dialect.quote(options.table)} WHERE ${text}`, params };
};
