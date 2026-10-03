---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-sql": patch
---

Differential filter harness (issue #153, ADR-0028).

- `BackendContract` rule 6 (reference subset semantics) now also runs a small
  generated corpus of predicates, order terms and limits over the contract's
  `rank`/`tag` columns, so every backend inherits the check for every operator
  in the core. This is stricter than before: text order is code-point order,
  so a backend whose text columns carry a locale collation fails the contract
  by design — ADR-0028 requires `COLLATE "C"` (Postgres) or `BINARY` (SQLite).
- `FilterCorpus` is a new `@thomasfosterau/legation-effect/internal` export: seeded corpus
  generators over Effect's `Random` service (`Random.withSeed`), a minimiser
  that shrinks a disagreeing predicate/row pair, and a disagreement reporter.
- `@thomasfosterau/legation-sql`'s tests gain the differential harness itself: `Predicate.test`
  and `Sql.compileWhere` on SQLite are compared against a Postgres oracle
  running in-process via PGlite, with the known JS divergences pinned until
  #155 closes them.
