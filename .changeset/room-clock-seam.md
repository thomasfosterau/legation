---
"@thomasfosterau/legation-cloudflare": patch
---

`RoomConfig` gains an optional `clock`, the clock the room's boot, heartbeat and request handling run on. Production leaves it unset and keeps the real clock; a test passes a `TestClock` so `publishTimeout` and the lease heartbeat can be tested with virtual time.

No behaviour change. `Room` keeps forwarding `publishTimeout` to both `DurableFanoutBroker` and `FanoutBus`, so a bound above the broker's 5 second default is honoured in full.
