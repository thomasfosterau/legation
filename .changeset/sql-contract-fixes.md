---
"@legation/effect": patch
"@legation/sql": patch
---

Two fixes surfaced by running `verifyBackendContract` over a real SQLite
executor (the commerce example): `SqlBackend`'s mutation-ledger upsert
re-bound a placeholder index, which renders an extra unmatched `?` under the
sqlite dialect (the fake-executor tests never bound params positionally) —
now `excluded.`-based and dialect-safe. And `verifyBackendContract` no longer
imposes a value-encoding convention the engine itself doesn't require
(ADR-0014 keeps values opaque): the idempotency rule checks the
discriminating field instead of exact value equality, and the evaluation rows
use a string discriminator instead of a boolean (SQLite has no boolean type).
