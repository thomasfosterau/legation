---
"@thomasfosterau/legation-sql": minor
---

`SqlBackend` now reports a committed rejection to every copy of the mutation, as Backend guarantee 1 requires (#366). A replayed copy of a rejected mutation lists it in `rejected` with the stored reason, and so does a copy that a concurrent call committed first: on SQLite that copy is listed directly, and on PostgreSQL it is refused with a transient `BackendError` whose retry lists it. Before, such a copy reported nothing, so a client whose push response was lost settled the rejected mutation as applied. The rejection is remembered in the ledger row, in the same transaction as the claim (or, on an executor without transactions, before the bump). A push forgets the rejections below its lowest id per client, as `MemoryBackend` does.

Action required: this changes the `sync_mutations` ledger table. Run the `ALTER TABLE` for your database before upgrading. A ledger without the column fails each push with a `BackendError` that names this migration, and writes nothing.

```sql
-- SQLite
ALTER TABLE sync_mutations ADD COLUMN rejections TEXT;

-- PostgreSQL
ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS rejections TEXT;
```

The sql README's "Ledger without the `rejections` column" section gives a check for the column, the same DDL, and the table a new install creates.
