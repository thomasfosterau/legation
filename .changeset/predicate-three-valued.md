---
"@legation/effect": minor
"@legation/sql": patch
---

`Predicate` evaluates under Postgres's three-valued semantics (ADR-0028,
#155). This is a behaviour change for rows whose filtered field is `null` or
absent.

- `Predicate.evaluate(predicate, row)` returns `Option<boolean>`: `Some(true)`,
  `Some(false)`, or `None` for unknown, with Kleene `And`/`Or`/`Not`. An
  absent attribute is NULL. `Predicate.test` is now
  `Option.getOrElse(evaluate(...), () => false)`, so every caller keeps its
  boolean signature but a row matches only when the result is definitely
  true. Rows with a NULL or absent field therefore stop matching `ne`,
  `Not(eq)`, a `Not(In)` miss and `NotIn`, exactly as they do in SQL. An app
  that relied on `ne` returning NULL rows must add an explicit `isNull`
  disjunct.
- Two wire-additive nodes: `IsNull { field, negated? }` and
  `NotIn { field, values }`, with constructors `Predicate.isNull`,
  `Predicate.isNotNull` and `Predicate.notIn` (also on the typed
  `Subset.for` builder). `Predicate.eq(f, null)` desugars to `isNull(f)` and
  `Predicate.ne(f, null)` to `isNotNull(f)`, so existing call sites keep
  their meaning — and `eq(f, null)` now also selects rows where the field is
  absent. A wire `Compare` or `In` carrying a `null` literal evaluates to
  unknown, as in Postgres; that form is deprecated.
- Text compares by Unicode code point (`Predicate.compareText`), the order of
  Postgres `COLLATE "C"` and SQLite `BINARY`, instead of UTF-16 code unit;
  the two differ only where astral characters meet U+E000–U+FFFF. Booleans
  order `false < true` under `lt`/`lte`/`gt`/`gte`.
- `Subset.comparator` sorts NULL and absent values after every non-null
  value ascending and before them descending (Postgres's default); it used
  to sort them first in both directions. The row-id tie-break is a code-point
  comparison. Existing cursor pages over text or nullable sort keys may
  re-order once on upgrade.
- `CollectionIndex` keeps one bucket for NULL-or-absent that `eq`/`In`/range
  lookups never return and `IsNull` reads directly; `ne`, `NotIn` and
  `IS NOT NULL` stay residual conjuncts. Sorted runs use the code-point
  comparator. The index is proven equal to the full scan over the
  differential corpus.
- `@legation/sql`: `Sql.compileWhere` compiles `IsNull` to `IS NULL` /
  `IS NOT NULL` and `NotIn` to `NOT IN (…)` (empty list → `1 = 1`). The
  `BackendContract` corpus now generates NULL, absent and astral text.
