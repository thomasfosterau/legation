---
"@thomasfosterau/legation-alchemy-cloudflare": minor
"@thomasfosterau/legation": minor
---

Out-of-band hints for the Cloudflare rooms (#679). `DurableFanoutBroker.publishOutOfBand({ shards, rooms, nodes, timeout? })` lets a cron or queue Worker that writes rows without a mutation poke every room leased on the write's topics, with each shard and room call bounded and fire-and-forget as in a room's own publish. `Room.make` takes a `hints` option, a `HintSource` the room runs on its bus; its doc comment and the README say that a polling source keeps the room from hibernating. `RoomObject` now extends `DurableFanoutBroker.PokeSurface`. In `@thomasfosterau/legation/internal`, `FanoutTopics.topicsForHints` derives the topics of a batch of change hints, the derivation `FanoutBus` publishes with.
