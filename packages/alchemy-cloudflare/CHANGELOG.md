# @thomasfosterau/legation-alchemy-cloudflare

## 0.3.0

### Minor Changes

- f1f0092: A room can use a per-request backend (#681): return `Backend.perRequest(acquire)` from `Room.make`'s `backend`, and the room builds the store in `acquire` once per push, pull and read, in that request's scope, so a Hyperdrive-backed `PgClient` is built from the current invocation's credentials and one push's transaction stays on its connection. The `backend` doc comment, the README and `docs/alchemy-postgres.md` (its Hyperdrive section, with an example over `Hyperdrive.ConnectClient`) say how.
- 486b0ef: **Breaking:** `Worker.RouterConfig.roomIdOf` returns `Effect<Option<string>, never, R>` instead of `Effect<string | undefined, never, R>` (#683), matching `anonymousRoomOf`. `Option.none()` is the anonymous caller (a 401, unless `anonymousRoomOf` routes it). Migrate by wrapping the result: `Option.fromNullishOr(id)` for a nullable lookup, or `Effect.succeed(Option.some(id))` for a constant id.

### Patch Changes

- 1ce8b2b: Effects that must run at a callback edge run on a runtime the adapter owns (#562). Background Sync's listener, the Svelte undo hooks and the devtools panel use a module-level `ManagedRuntime.make(Layer.empty)` in place of the implicit-runtime `Effect.runPromise` / `runFork` / `runSync`, and the room transport's poke socket offers to its queue with `Queue.offerUnsafe`. No behaviour changes.
- 2478811: Name the failures of the promises these packages await. A rejected KV delete, cache purge or forwarded invalidation (`EdgeInvalidation`), a rejected Background Sync registration lookup or registration (`BackgroundSync`) and an unreadable write-request body (`JsonApiFacade`) now carry a module-private tagged error with the rejection as its `cause`, where they were the generic `UnknownError`. Behaviour is unchanged; only the error a log line shows differs.
- dc243b9: `dist/` is one ESM module per source module instead of merged shared chunks (#678), so a consumer's bundler can tree-shake with `sideEffects: false`. The entries and their exports are unchanged.
- Updated dependencies [f1f0092]
- Updated dependencies [515a427]
- Updated dependencies [584ea1c]
- Updated dependencies [87e83f9]
  - @thomasfosterau/legation@0.5.0

## 0.2.0

### Minor Changes

- 85b11f6: Anonymous readers can be sharded over rooms (#679). `Worker.routeSync` takes `anonymousRoomOf`, which routes a caller `roomIdOf` left anonymous to a shared room named under the reserved `Worker.anonymousRoomPrefix` (`Option.none()` keeps the 401), so an anonymous caller never reaches a user's room; a `roomIdOf` id inside that namespace is refused with a 500. `Worker.shardByClientGroup({ shards, cookie? })` spreads anonymous callers over `shards` rooms by a stable hash of their client-group cookie. Without `anonymousRoomOf`, anonymous callers still get a 401.
- da296dc: Out-of-band hints for the Cloudflare rooms (#679). `DurableFanoutBroker.publishOutOfBand({ shards, rooms, nodes, timeout? })` lets a cron or queue Worker that writes rows without a mutation poke every room leased on the write's topics, with each shard and room call bounded and fire-and-forget as in a room's own publish. `Room.make` takes a `hints` option, a `HintSource` the room runs on its bus; its doc comment and the README say that a polling source keeps the room from hibernating. `RoomObject` now extends `DurableFanoutBroker.PokeSurface`. In `@thomasfosterau/legation/internal`, `FanoutTopics.topicsForHints` derives the topics of a batch of change hints, the derivation `FanoutBus` publishes with.
- ea344a3: `Room.make`'s `backend` and `hints` run with the room instance's `Scope` (#679), so a backend can hold a resource for the instance's life, such as a PostgreSQL pool built with `Layer.build(PgClient.layer(...))`. The README and the `backend` doc comment say what that lifetime is against hibernation and eviction, and that a Hyperdrive client must not be held across requests (#506).
- 82eb11e: The room (`Room.make`) presents each push, pull and read request's headers to its `identity` resolver as `Authorization.RequestCredentials` (ADR-0035, #219), so a resolver can verify the session cookie or API key the request carried. A resolver now has the core's new signature, `({ clientGroupId, credentials }) => …`.
- 0a725be: **Breaking:** `FanoutShard.make` is now an Effect value, not a function: write `LegationShard.make(FanoutShard.make)` instead of `FanoutShard.make()`. `Room.RoomObject`'s `webSocketMessage` and `webSocketClose` now declare the parameters Alchemy's Durable Object handler signature passes; nothing changes at runtime.

### Patch Changes

- Updated dependencies [da296dc]
- Updated dependencies [9441aa0]
- Updated dependencies [520e1c8]
- Updated dependencies [9b22e38]
- Updated dependencies [20d9793]
- Updated dependencies [da04d41]
- Updated dependencies [82eb11e]
- Updated dependencies [b0f51d9]
- Updated dependencies [ed8dd92]
- Updated dependencies [3c83004]
- Updated dependencies [e8e3419]
- Updated dependencies [0e102c0]
- Updated dependencies [aab6099]
- Updated dependencies [3ca13de]
- Updated dependencies [d5b8f8b]
- Updated dependencies [8a60f29]
- Updated dependencies [20d9793]
- Updated dependencies [89eef12]
- Updated dependencies [2afcd9f]
  - @thomasfosterau/legation@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [1760b99]
- Updated dependencies [cec6dba]
  - @thomasfosterau/legation@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [7c93af9]
  - @thomasfosterau/legation@0.2.0

## 0.1.0

### Minor Changes

- 604ffd3: New package `@thomasfosterau/legation-alchemy-cloudflare` (ADR-0034): the reference deployment of ADR-0022's topology on Cloudflare, built on the Effect-native services of Alchemy's Cloudflare provider. It replaces `@thomasfosterau/legation-cloudflare`, which was never published.

  - `Room.make(config)` is the per-user room's Alchemy Durable Object implementation: the sync server over stateless HTTP push/pull/read, CVRs in the object's storage (`DurableCvrStore`), a `FanoutBus` over the topic shards, and hibernatable sockets (`Cloudflare.upgrade`) that carry only contentless pokes. `backend`, `policy`, `identity` and `queries` are effects built in the object's per-instance phase; `shards` is the app's shard class. Every shard call, room poke and lease registration is bounded by `publishTimeout`.
  - `FanoutShard.make` is the topic shard's implementation, with a typed RPC surface (`register`, `publish`): a shard answers its leased rooms and the publishing room pokes each once, over the `poke` RPC, with every topic it matched.
  - The app declares the classes (`class LegationRoom extends Cloudflare.DurableObject<LegationRoom, Room.RoomObject>()("LegationRoom") {}`) and binds the implementations (`LegationRoom.make(Room.make(...))`, `LegationShard.make(FanoutShard.make)`).
  - `Worker.routeSync` routes an Alchemy Worker's `/sync` requests to the caller's room through the namespace's stub, answering `Option.none()` outside the base path. A room answers a route by the path's last segment.
  - `D1Executor.make(db)` is `SqlBackend`'s executor over `Cloudflare.D1.QueryDatabase`'s client; D1 has no interactive transactions, so it reports `transactional: false` and does not meet Backend guarantee 1 (#342, #353).
  - `RoomTransport`, `BindingTransport` and `EdgeInvalidation` are unchanged from the package this one replaces.

  Peers: `alchemy` and `@alchemy.run/cloudflare` at exactly 2.0.0-beta.85, and `effect ^4.1.0`, which Alchemy requires. `@cloudflare/workers-types` is not a peer.

### Patch Changes

- Updated dependencies [2a1f63c]
- Updated dependencies [ef59fa7]
- Updated dependencies [56a2e51]
- Updated dependencies [d09dc65]
- Updated dependencies [db2366a]
- Updated dependencies [97db489]
- Updated dependencies [cc67999]
- Updated dependencies [a94df19]
- Updated dependencies [d76b04d]
- Updated dependencies [6f53fb1]
- Updated dependencies [d675d2e]
- Updated dependencies [1743c2b]
- Updated dependencies [1c56914]
- Updated dependencies [615e792]
- Updated dependencies [c8d9afc]
- Updated dependencies [4709f41]
- Updated dependencies [f0348b4]
- Updated dependencies [3e29e1b]
- Updated dependencies [a053736]
- Updated dependencies [8a8adfc]
- Updated dependencies [8995115]
- Updated dependencies [8995115]
- Updated dependencies [87fa7a5]
- Updated dependencies [822001c]
- Updated dependencies [4c59860]
- Updated dependencies [961e604]
- Updated dependencies [5937efe]
- Updated dependencies [08ac9cd]
- Updated dependencies [1fc3725]
- Updated dependencies [8995115]
- Updated dependencies [8a8adfc]
- Updated dependencies [025fabb]
- Updated dependencies [0b8fccb]
- Updated dependencies [e7369e1]
- Updated dependencies [8995115]
- Updated dependencies [c856d66]
- Updated dependencies [01a8c64]
- Updated dependencies [3362c37]
- Updated dependencies [62dcb1c]
- Updated dependencies [be4be06]
- Updated dependencies [ae18cb3]
- Updated dependencies [be0a44d]
- Updated dependencies [cc2f5b7]
- Updated dependencies [e818dc4]
- Updated dependencies [d1b01a4]
- Updated dependencies [5496ddf]
- Updated dependencies [19eb4b0]
- Updated dependencies [a874acb]
- Updated dependencies [c5d3484]
- Updated dependencies [38c3147]
- Updated dependencies [e9363c0]
- Updated dependencies [fed4634]
- Updated dependencies [fcc52eb]
- Updated dependencies [454e75c]
- Updated dependencies [2003cd6]
- Updated dependencies [52c614f]
- Updated dependencies [94d6327]
- Updated dependencies [91f07db]
- Updated dependencies [6e9e119]
- Updated dependencies [6c2c802]
- Updated dependencies [ebcc6aa]
- Updated dependencies [a1b95d4]
- Updated dependencies [c105fbf]
- Updated dependencies [e1a028a]
- Updated dependencies [dfb8759]
- Updated dependencies [9260efb]
- Updated dependencies [0644af5]
- Updated dependencies [4b05d55]
- Updated dependencies
- Updated dependencies [82911cc]
- Updated dependencies [9c9f2b0]
- Updated dependencies [7b21d11]
- Updated dependencies [6f54de8]
- Updated dependencies [ab1fb4e]
- Updated dependencies [792d8f5]
- Updated dependencies [a3b2ee4]
- Updated dependencies [eb9555a]
- Updated dependencies [c0ab703]
- Updated dependencies [8c65627]
- Updated dependencies [26ad3f3]
- Updated dependencies [d7cafd2]
- Updated dependencies [cb0a33d]
- Updated dependencies [912d95d]
- Updated dependencies [7290d2b]
- Updated dependencies [41c33e3]
- Updated dependencies [a77261c]
- Updated dependencies [c47786c]
- Updated dependencies [501b12c]
- Updated dependencies [7f1efac]
- Updated dependencies [a04918b]
- Updated dependencies [cf0b26c]
- Updated dependencies [ddb1fda]
- Updated dependencies [f54f568]
- Updated dependencies [fc880dc]
- Updated dependencies [9cbd160]
- Updated dependencies [0bebedf]
- Updated dependencies [bc4c599]
- Updated dependencies [20a6e18]
- Updated dependencies [b4d2b80]
- Updated dependencies [2201b4c]
- Updated dependencies [0cdefe7]
- Updated dependencies [66f3b5b]
- Updated dependencies [7e11e61]
- Updated dependencies [6175e38]
- Updated dependencies [caf4761]
- Updated dependencies [821b10d]
- Updated dependencies [9e74a83]
- Updated dependencies [49fd066]
- Updated dependencies [06405ed]
- Updated dependencies [e7f4871]
- Updated dependencies [916d91b]
- Updated dependencies [47f4e15]
- Updated dependencies [f829146]
- Updated dependencies [13658a7]
- Updated dependencies [31cfb2c]
- Updated dependencies [a1cea1c]
- Updated dependencies [7e94abc]
- Updated dependencies [4fbd0b7]
- Updated dependencies [9d2f21b]
- Updated dependencies [3016170]
- Updated dependencies [f4a1a60]
- Updated dependencies [507ccb1]
- Updated dependencies [c671ccf]
- Updated dependencies [16889f0]
- Updated dependencies [fb2a992]
- Updated dependencies [22f320d]
- Updated dependencies [652ae7b]
- Updated dependencies [83bcf76]
- Updated dependencies [20e57d3]
- Updated dependencies [f010749]
- Updated dependencies [8d02113]
- Updated dependencies [bf9054d]
- Updated dependencies [e40c73a]
- Updated dependencies [ca38874]
- Updated dependencies [27e1040]
- Updated dependencies [e68eb3e]
- Updated dependencies [985c4d5]
- Updated dependencies [3be5abc]
- Updated dependencies [97db489]
- Updated dependencies [4a23603]
- Updated dependencies [f441941]
- Updated dependencies [a01f43b]
- Updated dependencies [9a6426b]
- Updated dependencies [97cc5f9]
- Updated dependencies [fc880dc]
- Updated dependencies [e34bc24]
- Updated dependencies [0470e1c]
- Updated dependencies [439f449]
- Updated dependencies [3a88118]
- Updated dependencies [1b8b120]
- Updated dependencies [cf48723]
- Updated dependencies [b4489c5]
  - @thomasfosterau/legation@0.1.0
