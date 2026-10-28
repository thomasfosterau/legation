---
"@thomasfosterau/legation-sql": minor
---

`evaluateMany` on PostgreSQL now recognises every number its JSON rows cannot
carry exactly, not only integers past ±(2^53 − 1): a `numeric` with more digits
than a double holds, and such a number inside a `json` / `jsonb` column. A pull
holding one falls back to one `evaluate` per subset, as a wide integer already
did, and the backend logs a warning once per collection and column, whose cause
is the new `SqlBackend.InexactJsonNumber` (it names the collection and column,
never the value). The README now says integer, double and text values belong
in typed columns (`integer`, `double precision`, `text`) rather than JSON.
