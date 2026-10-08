---
"@thomasfosterau/legation-effect": patch
---

`subscribe` on the Redis Streams broker no longer waits on Redis. The start
position lookup (`XREVRANGE`) moved into the subscription's reader, which retries
it with a 200 ms back-off and logs a warning on each retry. Previously a subscriber
made while Redis was unreachable never returned, which blocked `SyncServer`
construction (it subscribes to the bus). The reader still continues from the last
ID it saw, so the gap fix is unchanged. A publish that lands after `subscribe`
returns but before the reader resolves its start position can be missed; delivery
is best-effort (ADR-0009).
