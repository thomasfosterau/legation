---
"@thomasfosterau/legation-sql": patch
---

Fix the mutation-id bump on executors without transactions (`transactional: false`) failing on PostgreSQL. The upsert's `GREATEST` named the ledger's `last_mutation_id` unqualified, which PostgreSQL reads as ambiguous with `excluded`, so every push on such an executor was refused. The column is now qualified with the ledger table's name.
