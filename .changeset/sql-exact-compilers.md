---
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-effect": patch
---

`@thomasfosterau/legation-sql`'s compilers are exact on Postgres and SQLite (ADR-0028 §4 and
§6, #156): every predicate node compiles to a SQL boolean expression whose
three-valued result per row equals `Predicate.evaluate`, so the `WHERE`
returns precisely the rows the JS evaluator returns `Some(true)` for. The
differential harness proves it against a real Postgres (PGlite) and SQLite
over the whole generated corpus, set and per-row verdict both. `Sql.ts` no
longer describes itself as a superset pre-filter.

- **Literal kinds.** `Sql.compileWhere` and `Sql.compileSelect` take an
  optional `kinds` map (field → `Predicate.LiteralKind`: `text`, `integer`,
  `double`, `boolean`, `instant`) and a `foreignKinds` map (collection →
  kinds) for the inner `where` of an `Exists`. `Dialect` gains
  `textCollation` and `boolean`.
- **Collation clause.** A `Compare`, `In` or `NotIn` on a field declared
  `text` carries an explicit code-point collation on the column side:
  `"col" COLLATE "C" = $1` on Postgres, `"col" COLLATE BINARY = ?` on
  SQLite. The clause requires the declaration — a string literal alone never
  collates, since it may be bound against a `uuid`, `date`, enum or
  `timestamptz` column. The schema rule stands: declare filterable and
  sortable text columns `COLLATE "C"` (Postgres) or leave them `BINARY`
  (SQLite).
- **Typed binds.** A literal binds by the declared kind: strings for `text`
  and `instant`, numbers for `integer` and `double`, booleans per dialect. A
  literal of another JS type is a cross-type comparison (rule (d)) and binds
  as `NULL`, so its verdict is unknown exactly as in `Predicate.evaluate`
  and SQLite's affinity coercion never sees it; in a list such literals are
  dropped.
- **SQLite booleans are `0`/`1`.** The SQLite dialect binds boolean literals
  as `1`/`0` (the `node:sqlite` driver refuses a raw boolean), and
  `SqlBackend` decodes `0`/`1` back to booleans for columns whose new
  `TableMapping.kinds` entry says `boolean`; other columns stay exactly as
  the driver returns them. `SqlBackend` resolves an `Exists` like
  `MemoryBackend` does: NULL foreign values are left out and the rest are
  decoded by kind.
- `@thomasfosterau/legation-effect`: `Predicate.LiteralKind` is the one home of the kind
  vocabulary; `FilterCorpus.Column.kind` uses it and the corpus's `"string"`
  kind is renamed `"text"` to match ADR-0028.
