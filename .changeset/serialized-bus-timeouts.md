---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-cloudflare": patch
---

The publish of a push's change hints is bounded for every broker now. `makeSerialized` (and `layerSerialized`) bounds a custom `BusBroker`'s `publish` with a new `timeout` option, default 5 seconds, so a hung broker can no longer hold a push's commit-and-publish region open. A timed-out publish is logged and dropped, like the other bus failures. The `FanoutBus` `timeout` option now also documents that, on Durable Objects, one publish is many shard calls under one bound. The Cloudflare `Room` gains a `publishTimeout` option (default 5 seconds) that bounds its shard calls and lease registrations.
