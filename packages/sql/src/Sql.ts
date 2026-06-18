/**
 * Sql
 *
 * Translate a `Subset`'s predicate into a parameterized SQL `WHERE` clause —
 * the piece the audit calls out as the heart of a real SQL backend. The
 * translation is pure and dialect-aware (placeholder + identifier quoting);
 * the `SqlBackend` runs the result and applies the subset's order/limit/cursor
 * locally with `Subset.apply`, so the `WHERE` only has to return a superset.
 *
 * Predicate → SQL:
 * - `True` → `1 = 1`
 * - `Compare` → `col <op> ?` (or `col IS [NOT] NULL` for null equality)
 * - `In` → `col IN (?, ?, …)` (empty set → `1 = 0`)
 * - `And` / `Or` → parenthesized joins (empty And → `1 = 1`, empty Or → `1 = 0`)
 * - `Not` → `NOT (…)`
 */

import { Predicate } from "@thomasfosterau/effect-sync-core";

/** A SQL fragment plus its ordered bind parameters. */
export interface SqlFragment {
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
}

/** Placeholder + identifier-quoting rules for a SQL dialect. */
export interface Dialect {
  /** Bind placeholder for the 1-based parameter index. */
  readonly placeholder: (index: number) => string;
  /** Quote a column/table identifier. */
  readonly quote: (identifier: string) => string;
}

const quoteDouble = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/** SQLite / MySQL style: `?` placeholders. */
export const sqlite: Dialect = { placeholder: () => "?", quote: quoteDouble };

/** PostgreSQL style: `$1`, `$2`, … placeholders. */
export const postgres: Dialect = { placeholder: (index) => `$${index}`, quote: quoteDouble };

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

const compileNode = (predicate: Predicate.Predicate, dialect: Dialect, params: Params): string => {
  switch (predicate._tag) {
    case "True":
      return "1 = 1";
    case "Compare": {
      const column = dialect.quote(predicate.field);
      if (predicate.value === null) {
        return `${column} IS ${predicate.op === "ne" ? "NOT " : ""}NULL`;
      }
      return `${column} ${comparators[predicate.op]} ${params.bind(predicate.value)}`;
    }
    case "In": {
      if (predicate.values.length === 0) return "1 = 0";
      const placeholders = predicate.values.map((value) => params.bind(value)).join(", ");
      return `${dialect.quote(predicate.field)} IN (${placeholders})`;
    }
    case "And":
      if (predicate.predicates.length === 0) return "1 = 1";
      return predicate.predicates.map((inner) => compileNode(inner, dialect, params)).join(" AND ");
    case "Or": {
      if (predicate.predicates.length === 0) return "1 = 0";
      return `(${predicate.predicates.map((inner) => compileNode(inner, dialect, params)).join(" OR ")})`;
    }
    case "Not":
      return `NOT (${compileNode(predicate.predicate, dialect, params)})`;
    case "Exists": {
      // Correlated set membership: localField IN (SELECT foreignField FROM …).
      const inner = compileNode(predicate.where, dialect, params);
      const from = dialect.quote(predicate.collection);
      const column = dialect.quote(predicate.foreignField);
      return `${dialect.quote(predicate.localField)} IN (SELECT ${column} FROM ${from} WHERE ${inner})`;
    }
  }
};

/** Compile a predicate into a `WHERE`-ready fragment for a dialect. */
export const compileWhere = (
  predicate: Predicate.Predicate,
  dialect: Dialect = sqlite
): SqlFragment => {
  const params = new Params(dialect);
  const text = compileNode(predicate, dialect, params);
  return { text, params: params.values };
};

/**
 * Compile a `SELECT * FROM <table> WHERE <predicate>` for a subset. Order,
 * limit and cursor are left to the backend's `Subset.apply` (the `WHERE` is a
 * sound superset), so this stays a single, safe statement.
 */
export const compileSelect = (options: {
  readonly table: string;
  readonly where: Predicate.Predicate;
  readonly dialect?: Dialect;
}): SqlFragment => {
  const dialect = options.dialect ?? sqlite;
  const { text, params } = compileWhere(options.where, dialect);
  return { text: `SELECT * FROM ${dialect.quote(options.table)} WHERE ${text}`, params };
};
