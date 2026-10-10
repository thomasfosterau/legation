---
"@thomasfosterau/legation-effect": patch
---

`BackendContract.verifyBackendContract` gains an optional `awaitPeer` on `@thomasfosterau/legation-effect/internal`. Rule 11 holds a parked handler while the peer group's call runs. A backend whose peer does real I/O (PostgreSQL) can now supply `awaitPeer`, which returns once the peer has finished or is blocked on a lock the parked call holds, so the overlap is reached on every run instead of by scheduler luck (#416). Without it the rule keeps its bounded turn count, so existing callers are unchanged.

**For third-party backends:** the rule 11 handler is registered under `BackendContract.countUp.name` (`contract/count-up`). It passes `gate` unchanged to `park` between its read and its write, and writes the counter plus one. A handler that omits `park` fails rule 11 with "finished without reaching park()". Only the contract's own handler calls `park`.
