---
"@thomasfosterau/legation-effect": patch
---

The Redis Streams broker (`makeRedisBroker`) bounds each reader `XREAD BLOCK` at its `block` time plus 2 seconds. A read with no reply by then is logged, backed off and retried from the last ID seen, as a failed start lookup already was, so a connection that accepts a read and never answers no longer parks the subscriber silently. A normal BLOCK timeout (a null reply) is still a success, and `block: 0` is not bounded.
