---
"@thomasfosterau/legation-effect": patch
---

The Redis Streams broker (`makeRedisBroker`) resolves each subscription's start position once it succeeds, then reads on from the last entry it saw. A hint published between a block timeout and the next read is delivered: the read continues from a fixed ID (`XREVRANGE ... COUNT 1`, or `0-0` for an empty stream), not from `$`, which would move forward on each read. The `"$"` option keeps its meaning: a subscriber reads only hints published after its start position.

`subscribe` makes one start-position attempt and waits at most 500 ms for it, then returns either way. So `SyncServer` construction, which subscribes to the bus, waits at most 500 ms when Redis is unreachable. While Redis answers in time, a hint published once `subscribe` returns is never missed. If the attempt fails or times out, the subscription's reader makes the attempt on its first step, and retries each failed step with a back-off of 200 ms, doubling, capped at 5 s, until Redis answers. While Redis is unreachable, a publish that races the start can be missed; delivery stays best-effort (ADR-0009).

Each outage logs a warning on its first failed step, a debug line for each further retry, and an info line when Redis answers again.
