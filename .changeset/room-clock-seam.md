---
"@thomasfosterau/legation-cloudflare": patch
---

`RoomConfig` gains an optional `clock`, the clock the room's boot, heartbeat and request handling run on. Production leaves it unset and keeps the real clock; a test passes a `TestClock` so `publishTimeout` and the lease heartbeat can be tested with virtual time.

`Room` no longer forwards `publishTimeout` to `DurableFanoutBroker`. Its `FanoutBus` bound already wraps every broker call, including lease registration, so the broker's own bound is redundant. Each shard call is now bounded by the lesser of `publishTimeout` and the broker's 5 second default. The two agree at the default and for any `publishTimeout` of 5 seconds or less, so behaviour there is unchanged.
