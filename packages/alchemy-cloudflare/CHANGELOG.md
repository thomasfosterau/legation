# @thomasfosterau/legation-alchemy-cloudflare

## 0.5.0

### Minor Changes

- a212238: Mutation ids, client group ids and row ids are now branded types, so the compiler rejects one where another is expected: `MutationId` (a branded `number`), `ClientGroupId` and `RowId` (branded `string`s). They are defined in `Protocol` (`@thomasfosterau/legation/internal`) and re-exported where apps use them: `Client.ClientGroupId`, `Client.MutationId`, `Backend.ClientGroupId`, `Backend.MutationId` and `Collection.RowId`. A node's `Node.Id` is now a `RowId` too, so every node id works wherever a row id does.

  The brands are compile-time only: the wire format, the stored formats and the runtime values don't change, and no migration of data is needed.

  **Migration.** Each brand's schema has a `make` constructor for literals and values you mint yourself:

  - `Client.make`, `ClientEngine.make` / `layer`, `Transport.makeInMemory`, `RpcTransport`, `ElectedHost.run`, `JsonApiSync.layer` and `Hydration` snapshots take a `ClientGroupId`: replace `clientGroupId: "g1"` with `clientGroupId: Client.ClientGroupId.make("g1")`. SvelteKit's `clientGroupId(cookies)` already returns one.
  - A `Backend.SyncContext` (from an identity resolver, a `RestHandlers` `context`, or a direct `backend.applyMutations` call) carries a `ClientGroupId`: use `Backend.ClientGroupId.make(...)`.
  - A `Protocol.Mutation` built by hand (seeding a backend with `applyMutations`, `Server.mutate`) needs `mutationId: Client.MutationId.make(n)`. `lastMutationIds` maps are `Record<string, MutationId>`.
  - Row ids read from the engine (`row.id` from a query, patches, CVRs, `ChangeHint.ids`, `SeedRow.id`, `Backend.getRows`) are `RowId`. A backend or handler that returns `ChangeHint`s builds their ids with `Collection.RowId.make(id)`; a row id mapped from your own data (a JSON:API resource id, a SQL column) needs the same.
  - Write inputs still take plain strings: `LocalWriter` and `BackendWriter` (`put` / `del` / `get`) and `Server.broadcast`'s `ids` accept a `string` id, so handlers that mint ids from their args don't change.
  - Code generic over a schema's codec, such as `Schema.Codec<A>`, should take the encoded type too (`Schema.Codec<A, I>`) so a branded type isn't widened back to its unbranded encoding.

- 5b65c8f: Each module the root entry re-exports as a namespace is now also its own subpath, named after the namespace, as Effect's own packages are laid out: `import * as Node from "@thomasfosterau/legation/Node"` is the root's `Node`. The engine seams stay on `@thomasfosterau/legation/internal` only, and the deprecated `Mutator` alias has no subpath (use `/Mutation`). Nothing is removed: imports from the root entry keep working.
- e671751: `RoomTransport`'s `status` and `statusChanges` now follow the poke socket instead of always reading `"connected"`, so a UI can show that live updates are degraded while the socket is down: `"connecting"` until the socket first opens (it dials when `pokes` is first subscribed) and while it re-dials, `"connected"` while it is open, and `"disconnected"` once a `reconnect` schedule ends. Push, pull and read never wait on the socket, so sync stays correct over HTTP alone. Each re-open emits `"connected"`, which starts the sync loop's push and pull, so pokes missed during an outage are caught up at once. A label that treated anything but `"connected"` as offline will now show the socket's outages; read `"disconnected"` as offline instead.
- 58f39a4: `RoomTransport`'s poke socket runs on `effect/socket` (`Socket.makeWebSocket`) and reconnects through `Stream.retry`, so a re-dial is interruptible and follows the `Clock` (testable with `TestClock`). The new `reconnect` option takes the re-dial `Schedule`; without it, `defaultReconnect(maxReconnectDelayMillis)` (also exported) keeps the old linear backoff of one more second per failed attempt, capped at `maxReconnectDelayMillis`, restarting once a frame arrives. `maxReconnectDelayMillis` keeps working. Two behaviour changes: a socket that has not opened within 10 seconds is abandoned and re-dialled, and a `reconnect` schedule that ends fails `pokes` with a `TransportError`. The socket's constructor can be replaced through `Socket.WebSocketConstructor` in the context.

  `BindingTransport` sends through Effect's Fetch `HttpClient` over the binding's `fetch`, as `RoomTransport` does, and decodes each answer with the protocol's response schema: an answer that is not the protocol's response now fails with a `TransportError` ("binding /pull answer is invalid") instead of reaching the engine unchecked.

- e671751: The carrier seams' subscriptions are now streams instead of pull-style `{ take }` handles. `MirrorChannel.subscribe`, `BusBroker.subscribe`, `InvalidationBus.subscribe` and `FanoutBroker.pokes` return `Effect<Stream<A>, never, Scope>`: the subscription is still open once the effect completes, so nothing published afterwards is missed however late the stream runs, and it still closes with the scope. The stream is single-use, keeps arrival order, and ends when the scope closes. Buffering is unchanged: the in-process bus, the memory broker and the in-process fan-out broker stay bounded and dropping; the listener-backed carriers stay unbounded. `MirrorChannel.MirrorInbox`, `InvalidationBus.HintSubscription` and `FanoutBroker.TopicPokes` are removed.

  **Migration.**

  - A consumer that looped on `take` runs the stream: replace `const sub = yield* bus.subscribe; yield* Effect.forkScoped(Effect.forever(sub.take.pipe(Effect.flatMap(handle))))` with `const hints = yield* bus.subscribe; yield* Effect.forkScoped(Stream.runForEach(hints, handle))`. The same goes for `channel.subscribe` and `broker.pokes(roomId)`.
  - A custom `BusBroker` or `MirrorChannel` over an event source no longer feeds a queue by hand: build the stream with `Stream.fromEventListener` (or `Stream.callback`) and open it with `MirrorChannel.subscribeNow`, as in `subscribe: MirrorChannel.subscribeNow(Stream.fromEventListener(socket, "message").pipe(Stream.map((event) => event.data)))`. A broker over a `PubSub` returns `Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)`. A custom `FanoutBroker.pokes` returns a stream the same way.

### Patch Changes

- 6a87c19: Reusable operations are now `Effect.fn` / `Effect.fnUntraced` functions instead of arrows returning `Effect.gen`. Operation-level calls now emit a tracing span named `<package>/<Module>.<op>`: in `@thomasfosterau/legation`, for example `legation/Client.make`, `legation/Client.connect`, `legation/ClientEngine.pushClaimed`, `legation/ClientEngine.applyPull`, `legation/ClientEngine.seed`, `legation/ClientEngine.ensureSubset`, `legation/SyncServer.readPullOnce`, `legation/Server.mutate`, `legation/Mirror.read`, the `legation/Hydration.*`, `legation/Transport.*` and `legation/Paced.*` constructors, and the `legation/BackendContract.rule*` conformance steps; in `@thomasfosterau/legation-browser`, `legation-browser/BackgroundSync.flush` (renamed from `legation.backgroundSync.flush`), `legation-browser/ServiceWorkerHost.start`, `legation-browser/ElectedHost.run` and others; in `@thomasfosterau/legation-jsonapi`, `legation-jsonapi/JsonApiBackend.getRows`, `.sendAtomic`, `.applyAtomic`, `.applyMutations` and the `CollectionLoader` / `JsonApiFacade` handlers; in `@thomasfosterau/legation-alchemy-cloudflare`, `legation-alchemy-cloudflare/Worker.routeSync` and `legation-alchemy-cloudflare/DurableFanoutBroker.make`. Per-row, per-poke and per-change internals (overlay replay, patch apply, live views, the store's journal, the join engine, CVR diffs, fan-out) stay untraced. Types and behaviour are unchanged; a trace that filtered on `legation.backgroundSync.flush` should match the new name.
- 3ea8640: Failures that a caller can act on are now typed errors or `Result`s instead of throws and defects, and background work reports how it stopped.

  **Sync loop.** `ClientEngine.runSync` is now `Effect<void, never, Scope>`: it never failed (each leg retries and then surfaces its failures on `syncFailures`), and its type now says so. A leg that dies (a defect in a transport stream, for example) is logged at `Error` with its cause and handed to any installed `ErrorReporter` (`Effect.withErrorReporting`), where before it stopped without a trace. `Client.make` and `JsonApiSync.start` no longer wrap the loop in `Effect.orDie`. Migration: drop any `Effect.orDie`, `Effect.ignore` or `catchTag` you applied to `runSync`; a `catchTag` on it no longer type-checks.

  **One-shot reads fail with the view's error.** `Query.run`, `Query.runRows`, `Related.query`, `Related.queryRows`, `Related.queryWith`, `Related.resolveExistsLocally` and `legation-jsonapi`'s `Relationships.query` now fail with `ClientViewError` when the view cannot be read (a store error, or a mirror that lost its host), where they died before. `Client.query` and `Client.answer` already declared that error and now fail with it. Migration: handle (or `Effect.orDie`) the new error channel where you call these directly.

  **Live joins end instead of hanging.** A `Related.observe` join (and every observed read with `include`) whose base or foreign observer dies now ends with that defect; before, the join stopped emitting and never ended. The auto-subscribing relational read (`Related.related`, `Related.trackEdges`) logs a failed read of its base rows and reconciles again on the next change, rather than dying.

  **Reads are compiled when the effect runs.** `Client.query`, `Client.answer`, `Client.observe`, `Client.observeAnswers`, `Client.coverageOf`, `Query.run`, `Query.runRows` and `Query.observe` compile the read when the effect or stream runs, so an unknown collection or edge (a read that bypassed `Query.Validate`) is a defect of the effect, not an exception thrown at the call. `Query.planResult` is new: the `Result` that `Query.plan` throws from and `Query.tryPlan` fails with.

  **`FractionalIndex` (`/internal`).** `generateBetween` and `generateNBetween` return `Result<…, InvalidBounds>` instead of throwing, and `InvalidBounds` is exported. `generateNBetween` now checks its bounds even for a count of 0. Migration: unwrap with `Result.match` (or `Result.getOrThrowWith(result, identity)` where your bounds are ordered by construction).

  **`FilterCorpus` (`/internal`).** `resolveSeed` returns `Result<number, InvalidCorpusInput>`; `generateRows` and `generateCorpus` fail with `InvalidCorpusInput` for a row count below `minimumRows`, where they threw (a defect) before. `InvalidCorpusInput` is exported. Migration: `Result.getOrThrowWith(FilterCorpus.resolveSeed(env), identity)` at a test's module top level, and handle or `orDie` the new error channel.

  **`legation-jsonapi` URL encoding.** `JsonApiQuery.canonical`, `toRequestOptions`, `buildQueryString` and `flatFilter` keep their signatures and still throw a `QueryError` for input they refuse; internally each is now a `Result`, so `urlReads(…).canonical` and the `defaultEncoder` fail with that `QueryError` directly. A filter tree that the flat codec cannot encode is now a `QueryError` from `flatFilter` and `buildQueryString`, where it was a `SchemaError`.

  **`legation-alchemy-cloudflare`.** `BindingTransport` reads a failed call's error body without throwing inside its promise; the `TransportError` it fails with is unchanged.

- Updated dependencies [a212238]
- Updated dependencies [a212238]
- Updated dependencies [39b395c]
- Updated dependencies [a212238]
- Updated dependencies [6a87c19]
- Updated dependencies [0ece363]
- Updated dependencies [e671751]
- Updated dependencies [5b65c8f]
- Updated dependencies [a212238]
- Updated dependencies [e671751]
- Updated dependencies [5b65c8f]
- Updated dependencies [99d89bb]
- Updated dependencies [e671751]
- Updated dependencies [3ea8640]
  - @thomasfosterau/legation@0.7.0

## 0.4.1

### Patch Changes

- caa0dfe: A few reads of untyped values use guards instead of casts. Valid data behaves as before; on malformed data, `BackendContract` reads a non-numeric counter row as absent, and the Durable Object binding transport falls back to its default message for a non-string error body.
- d4ffe63: JSON is encoded and decoded through Schema's JSON codec. The text is byte-identical; a value with no JSON text (`undefined`, a function, a `BigInt`, a cycle) now fails with a `SchemaError` instead of a `TypeError` or an `undefined` result.
- Updated dependencies [caa0dfe]
- Updated dependencies [d4ffe63]
  - @thomasfosterau/legation@0.6.2

## 0.4.0

### Minor Changes

- a2786dc: The `alchemy` and `@alchemy.run/cloudflare` peers move to exactly `2.0.0-beta.87` (were `2.0.0-beta.85`), and the `effect` peer to `^4.1.4` (was `^4.1.0`), because Alchemy 2.0.0-beta.87 peers `effect ^4.1.4`. Upgrade Alchemy and `effect` together with this release.

### Patch Changes

- a6cb2f0: Doc comments no longer cite issue numbers.
- 64d8c43: `Room.make`'s `backend` doc comment says to bind a Hyperdrive configuration with query caching disabled: Hyperdrive caches reads outside a transaction without invalidating them on a write, and the pull's reads run outside one. Hyperdrive's transaction pooling keeps a push atomic.
- 8d3d468: The docs no longer call a room hibernation-friendly. `FanoutBus`'s lease heartbeat keeps a timer pending, so a room Durable Object stays in memory, billed for its duration, until the platform evicts it; `Room.make`'s doc comments and the README now say so.
- Updated dependencies [a6cb2f0]
- Updated dependencies [7cd6f7f]
- Updated dependencies [cfa9b14]
- Updated dependencies [fc73997]
  - @thomasfosterau/legation@0.6.1

## 0.3.1

### Patch Changes

- f04f4de: `RoomTransport.make` now sends its push, pull and read requests through Effect's Fetch `HttpClient` instead of calling `fetch` directly. The request is unchanged: a JSON `POST` with your `headers`, and no `b3` or `traceparent` trace headers, so a cross-origin room needs no extra CORS allowance. Each answer is now decoded through the protocol's response schema, and an answer that doesn't match it fails with `TransportError`. Interrupting a request now aborts it. `make` still returns a `ClientTransport` with no requirements.

  `FanoutShard.ShardObject` is now declared in a private module and re-exported from `FanoutShard`. Its name and shape are unchanged.

- Updated dependencies [a7d5a09]
  - @thomasfosterau/legation@0.6.0

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
