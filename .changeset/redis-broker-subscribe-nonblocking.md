---
"@thomasfosterau/legation-effect": patch
---

`subscribe` on the Redis Streams broker no longer waits on Redis indefinitely. It
makes one attempt at the start position, waiting at most 500 ms, and returns
either way; before, a subscriber made while Redis was unreachable never returned,
which blocked `SyncServer` construction (it subscribes to the bus). While Redis
answers in time, a hint published once `subscribe` returns is never missed. If the
attempt fails or times out, the subscription's reader resolves the start position
on its first step and retries with a back-off of 200 ms, doubling, capped at 5 s.
A publish that races the start can be missed while Redis is unreachable; delivery
is best-effort (ADR-0009). Retries log a warning on the first failure of an
outage, a debug line for each further retry, and an info line when Redis answers
again.
