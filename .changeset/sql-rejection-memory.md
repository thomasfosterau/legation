---
"@thomasfosterau/legation-sql": minor
---

`SqlBackend` now reports a committed rejection to every copy of the mutation, as Backend guarantee 1 requires (#366). A replayed copy of a rejected mutation, or a copy dropped because a concurrent call committed first, lists it in `rejected` with the stored reason. Before, such a copy reported nothing, so a client whose push response was lost settled the rejected mutation as applied. The rejection is remembered in the ledger row, in the same transaction as the claim (or, on an executor without transactions, before the bump). A push forgets the rejections below its lowest id per client, as `MemoryBackend` does.

Action required: this changes the `sync_mutations` ledger table. Run the `ALTER TABLE` for your database before upgrading. A ledger without the column fails each push with a `BackendError` that names this migration, and writes nothing.

```sql
-- SQLite
ALTER TABLE sync_mutations ADD COLUMN rejections TEXT;

-- PostgreSQL
ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS rejections TEXT;
```

The sql README's "Migrating to 0.2.0" section gives the same DDL and the table a new install creates.
