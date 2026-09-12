---
"@legation/sql": minor
---

`TableMapping` can be derived from a `Collection` and can separate the
relation reads evaluate against from the table mutator handlers write to,
and can mark a row a tombstone (#204):

- **`SqlBackend.fromCollection(collection, options)`** derives a mapping's
  `kinds` from the collection's declared filterable set
  (`Collection.filterDeclarationOf`, #154) instead of restating column names
  and kinds by hand. `table`, and optionally `readRelation` / `idColumn` /
  `versionColumn` / `tombstone`, are still given explicitly; the existing
  hand-written record shape remains the override path.
- **`TableMapping.readRelation`** names the relation `evaluate`, `getRows`
  and `Exists` resolution read from when it differs from `table` — the real
  shape of an app whose current-state relation is a Postgres view over a
  root version table and a leaf, joined at exactly the leaf's current
  version. `SqlBackend` never writes rows itself, so `table` stays the
  write target mutator handlers address.
- **`TableMapping.tombstone`** is a `Predicate` (the engine's own filter
  vocabulary, not a bespoke shape): a row matching it is dropped from
  `evaluate`'s returned entries, so it is simply absent from the next CVR
  view and `Cvr.diff` reports it as a delete, exactly like a row that
  vanished from the relation outright (the fail-closed case the model
  already relied on, now pinned by a test).
