---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-cloudflare": patch
---

The publish of a push's change hints is bounded by a timeout now that it runs
inside the uninterruptible commit-and-publish region. A hung broker used to hold
that region open indefinitely, so a push could never finish. Each broker call the
bus makes is now bounded: `FanoutBus` (its publish and lease registration, option
`timeout`), the Redis broker's `XADD` (option `timeout`), and the Durable Object
`DurableFanoutBroker` (its shard calls, option `timeout`, which aborts the request).
All three default to 5 seconds. A timed-out call is logged and dropped, the same as
any other bus failure: a lost poke only delays the next pull, so correctness never
depends on the bus.
