---
"@thomasfosterau/legation-effect": minor
---

`BackendContract.verifyBackendContract` probes cross-group lost updates (guarantee 1, #353). A new rule 11 parks a handler in one client group after it reads a counter, lets another group increment the same row and commit, then resumes the parked handler. Both increments must land, so the counter must read 2. A backend whose handler read is not validated at commit writes the stale count over the other group's commit and fails the rule. A backend that serialises the two (a lock, or serialisable isolation) passes, whether it orders them or refuses one with a transient `BackendError`, which the harness retries. A backend whose peer call waits behind the parked one passes too: the rule releases the parked handler after a bounded number of scheduler turns, so it does not deadlock.

The probe runs through a new contract mutator, `BackendContract.countUp` (`contract/count-up`), with args `{ collection, id, gate }`. Its handler reads the counter, calls `BackendContract.park(gate)` between the read and the write, then writes the counter plus one. `park` is a no-op unless the harness has registered `gate`, so a registered handler that never calls it fails rule 11: the probe then has nothing to test. `park` is exported from `@thomasfosterau/legation-effect/internal`, and the gate is named by a string in the args, so the mutation stays serialisable.

**Action required:** backend authors who run `verifyBackendContract` must register `BackendContract.countUp`, with a handler that reads, calls `park(gate)`, then writes. An unregistered mutator fails rule 11. `BackendContract.memoryHandlers` already includes it. A non-transactional executor (D1-style) does not meet guarantee 1 (#342), so it is not run through this contract.
