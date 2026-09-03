---
"@legation/sql": minor
"@legation/effect": patch
---

`@legation/sql`'s compilers are exact on Postgres and SQLite (ADR-0028 §4 and
§6, #156): every predicate node compiles to a SQL boolean expression whose
three-valued result per row equals `Predicate.evaluate`, so the `WHERE`
returns precisely the rows the JS evaluator returns `Some(true)` for. The
differential harness proves it against a real Postgres (PGlite) and SQLite
over the whole generated corpus, set and per-row verdict both. `Sql.ts` no
longer describes itself as a superset pre-filter.

- **Collation clause.** Every text `Compare`, `In` and `NotIn` carries an
  explicit code-point collation on the column side: `"col" COLLATE "C" = $1`
  on Postgres, `"col" COLLATE BINARY = ?` on SQLite. The schema rule stands:
  declare filterable and sortable text columns `COLLATE "C"` (Postgres) or
  leave them `BINARY` (SQLite) so the clause costs no index use.
- **Literal kinds.** `Sql.compileWhere` and `Sql.compileSelect` take an
  optional `kinds` map (field → `Predicate.LiteralKind`: `text`, `integer`,
  `double`, `boolean`, `instant`). `text` gets the collation clause;
  `instant` does not (a `timestamptz` column rejects one); numbers bind as
  numbers; booleans bind per dialect. Without a kind the literal's JS type
  decides, and a string is treated as `text`. `Dialect` gains
  `textCollation` and `boolean`.
- **SQLite booleans are `0`/`1`.** The SQLite dialect binds boolean literals
  as `1`/`0` (the `node:sqlite` driver refuses a raw boolean), and
  `SqlBackend` decodes `0`/`1` back to booleans for columns whose new
  `TableMapping.kinds` entry says `boolean`; other columns stay exactly as
  the driver returns them.
- `@legation/effect`: `Predicate.LiteralKind` is the one home of the kind
  vocabulary; `FilterCorpus.Column.kind` uses it and the corpus's `"string"`
  kind is renamed `"text"` to match ADR-0028.
