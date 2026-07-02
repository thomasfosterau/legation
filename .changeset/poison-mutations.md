---
"@legation/effect": minor
"@legation/sql": minor
"@legation/jsonapi": minor
---

Permanent mutation rejection semantics (#35). A mutator handler can now fail
with the new `MutationRejected` error to mark a failure permanent (failed
validation, revoked permission, violated business rule). The backend records
the mutation as processed — bumps `lastMutationId` atomically **without**
applying effects — so a poison mutation is acknowledged and skipped rather than
wedging the queue: mutations behind it still apply, and the client drops the
optimistic effect on the next rebase with no app code. A `BackendError` keeps
today's transient behaviour (abort the batch, client retries).

- `Backend.ApplyResult` gains an optional `rejected` list; `PushResponseSchema`
  gains an additive optional `rejected` field (older clients ignore it, and the
  per-mutation outcome surface #36 reads it).
- `MemoryBackend` rolls a rejected mutation's staged writes back (snapshot),
  `SqlBackend` via a per-mutation `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, and
  `JsonApiBackend` classifies HTTP 4xx (except 408/429) as permanent rejections.
- `BackendContract.verifyBackendContract` gains a rule covering both failure
  classes.
- `CONTEXT.md` documents the "transient failure" vs "permanent rejection"
  glossary entries.
