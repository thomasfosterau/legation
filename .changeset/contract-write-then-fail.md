---
"@thomasfosterau/legation-effect": minor
---

`BackendContract.verifyBackendContract` probes write-then-`BackendError` (#343).
A new contract mutator, `BackendContract.writeThenFail` (`contract/write-then-fail`),
writes a row and then fails transiently. The new rule 10 checks that the row keeps
its value and version, no new row appears, and `lastMutationId` is not bumped, so
the client's retry applies the mutation again. Guarantee 1 (`Backend.ts`) requires
this, and `failAlways` does not probe it because it writes nothing first.

Visibility before the bump is documented in `BackendContract` as a per-backend
obligation, not a generic rule: the harness cannot observe a backend mid-mutation.

**Action required:** backend authors who run `verifyBackendContract` must register
`BackendContract.writeThenFail` with a handler that writes a row and then fails with
`BackendError`. An unregistered mutator fails the rule. `BackendContract.memoryHandlers`
already includes it.
