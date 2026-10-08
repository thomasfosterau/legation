---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-jsonapi": patch
---

`BackendContract.verifyBackendContract` probes write-then-`BackendError` (#343).
A new contract mutator, `BackendContract.writeThenFail` (`contract/write-then-fail`),
writes a row and then fails transiently. The new rule 10 checks that the row keeps
its value and version, no new row appears, and `lastMutationId` is not bumped, so
the client's retry applies the mutation again. Guarantee 1 (`Backend.ts`) requires
this, and `failAlways` does not probe it because it writes nothing first.

Visibility before the bump is documented in `BackendContract` as a per-backend
obligation, not a generic rule: the harness cannot observe a backend mid-mutation.

The unknown-mutator `BackendError` that `MemoryBackend`, `SqlBackend` and
`JsonApiBackend` raise now carries a typed cause, built by `UnknownMutator.make`
(`@thomasfosterau/legation-effect/internal`). Rule 10 and rule 4 (`contract/fail`, #382)
recognise an unregistered mutator by that cause, so a backend that words the message
differently is still caught. The exact message `Unknown mutator: <name>` stays as a
fallback for a third-party backend that does not use the helper yet. Rule 4 now also
needs the probe to fail with a `BackendError`: a `failAlways` that dies with a defect
fails the rule instead of passing it.

**Action required:** backend authors who run `verifyBackendContract` (imported from
`@thomasfosterau/legation-effect/internal`) must register `BackendContract.failAlways`
and `BackendContract.writeThenFail`. The second is a handler that writes a row and then
fails with `BackendError`, called with args `{ collection, id }`. An unregistered mutator
fails rule 4 or rule 10. `BackendContract.memoryHandlers` already includes both. A
non-transactional executor (D1-style) fails rule 10 by design, since each statement
commits on its own (#342), so it is not run through this contract.
