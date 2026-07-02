---
"@legation/effect": minor
"@legation/sql": minor
"@legation/jsonapi": patch
---

Add the relational `Predicate.exists` node: a correlated relationship test
(this row matches if a row exists in another collection whose `where` holds and
whose `foreignField` equals this row's `localField`). Backends resolve it to an
allow-set with `Predicate.resolveExists` before evaluation — MemoryBackend over
its rows, the SQL backend via a `SELECT DISTINCT` subquery (the `Sql` translator
also compiles `Exists` to a correlated `IN (SELECT …)`). This closes the deeper
parts of the relational-query and relationship-scoped-auth gaps: server-side
joins and "visible if you're a member of the project" auth **without
denormalizing** the join key onto the row. The JSON:API backend can't resolve
correlated joins over REST and fails closed on `Exists`.
