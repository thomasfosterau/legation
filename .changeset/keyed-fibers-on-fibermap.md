---
"@thomasfosterau/legation": patch
---

`EngineHost` keeps its in-flight host requests in a `FiberMap`. A second `HostRequest` a mirror sends under a request id still in flight now interrupts the first and answers the second, where both used to run and a cancel reached only the newer one. Paced mutations, `Subscriptions`' grace timers and the related-rows join's foreign observers now run their keyed background fibers on `FiberMap` too, with no change in behaviour.
