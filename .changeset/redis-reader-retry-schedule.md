---
"@thomasfosterau/legation": patch
---

The Redis Streams broker's reader (`BusBrokers.makeRedisBroker`) retries a failed step with `Effect.retry` over a capped exponential `Schedule` instead of a hand-rolled back-off loop. The back-off (200 ms, doubling, capped at 5 s), the outage logging (a warning on the first failure, debug per further retry, info on recovery) and the resume-from-last-ID behaviour are unchanged.
