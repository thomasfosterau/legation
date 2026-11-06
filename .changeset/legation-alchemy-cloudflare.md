---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

New package `@thomasfosterau/legation-alchemy-cloudflare` (ADR-0034): the reference deployment of ADR-0022's topology on Cloudflare, built on the Effect-native services of Alchemy's Cloudflare provider. It replaces `@thomasfosterau/legation-cloudflare`, which was never published.

- `Room.make(config)` is the per-user room's Alchemy Durable Object implementation: the sync server over stateless HTTP push/pull/read, CVRs in the object's storage (`DurableCvrStore`), a `FanoutBus` over the topic shards, and hibernatable sockets (`Cloudflare.upgrade`) that carry only contentless pokes. `backend`, `policy`, `identity` and `queries` are effects built in the object's per-instance phase; `shards` is the app's shard class. Every shard call, room poke and lease registration is bounded by `publishTimeout`.
- `FanoutShard.make()` is the topic shard's implementation, with a typed RPC surface (`register`, `publish`): a shard answers its leased rooms and the publishing room pokes each once, over the `poke` RPC, with every topic it matched.
- The app declares the classes (`class LegationRoom extends Cloudflare.DurableObject<LegationRoom, Room.RoomObject>()("LegationRoom") {}`) and binds the implementations (`LegationRoom.make(Room.make(...))`, `LegationShard.make(FanoutShard.make())`).
- `Worker.routeSync` routes an Alchemy Worker's `/sync` requests to the caller's room through the namespace's stub, answering `Option.none()` outside the base path. A room answers a route by the path's last segment.
- `D1Executor.make(db)` is `SqlBackend`'s executor over `Cloudflare.D1.QueryDatabase`'s client; D1 has no interactive transactions, so it reports `transactional: false` and does not meet Backend guarantee 1 (#342, #353).
- `RoomTransport`, `BindingTransport` and `EdgeInvalidation` are unchanged from the package this one replaces.

Peers: `alchemy` and `@alchemy.run/cloudflare` at exactly 2.0.0-beta.85, and `effect ^4.1.0`, which Alchemy requires. `@cloudflare/workers-types` is not a peer.
