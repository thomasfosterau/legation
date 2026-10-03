---
"@thomasfosterau/legation-effect": minor
---

Add `BusBrokers.makeBroadcastChannelBroker`: a concrete `BusBroker` over a
`BroadcastChannel` for same-machine cross-context fan-out (browser tabs, Node
worker threads), joining the existing Redis Streams and WebSocket/Durable-Object
brokers. It honors the bus contract's self-delivery (a `BroadcastChannel` omits
the sender, so `publish` also offers to this broker's own subscribers).
