# packages/alchemy-cloudflare — `@thomasfosterau/legation-alchemy-cloudflare`

The reference deployment on Cloudflare (ADR-0022 topology, ADR-0023 topic-derived fan-out), built on Alchemy's Effect-native Cloudflare provider (ADR-0034). Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- The room Durable Object implementation (`Room.make`), the topic fan-out shard (`FanoutShard.make`), the stateless Worker router (`Worker.routeSync`), the D1 executor, the CVR store over DO storage, and the transports and edge-invalidation sinks. Imports from the workspace: `@thomasfosterau/legation` only (its `./internal` and `./sql` entries included).
- **Required peers:** `alchemy` and `@alchemy.run/cloudflare`, exact `2.0.0-beta.85` (`catalogs.alchemy-peers`; each `@alchemy.run/*` release pins `alchemy` exactly, and beta.85 is the release the apps deploy with), and `effect ^4.1.0`, because Alchemy requires it. This package's `effect` floor is 4.1.0; the rest of legation stays on `^4.0.0`. Moving the Alchemy pin moves the dev catalog entries and `catalogs.alchemy-peers` together, with a `minor` changeset.
- **Write against the provider's services, never raw workerd types:** `Workers.DurableObjectState` / `DurableObjectStorage` / `WebSocket` / `upgrade`, `Workers.DurableObject<…>` namespaces and their typed RPC stubs, `D1.QueryDatabaseClient`. `@cloudflare/workers-types` is a devDependency only (the provider's declarations import it); the source imports nothing from it, so it is not a peer.
- **The app declares the Durable Object classes**, not this package: `class LegationRoom extends Cloudflare.DurableObject<LegationRoom, Room.RoomObject>()("LegationRoom") {}` and its shard sibling. A class declaration is a top-level call, which `"sideEffects": false` forbids in `dist/`. The package exports the implementations (`Room.make`, `FanoutShard.make`) and the surfaces they satisfy (`Room.RoomObject`, `FanoutShard.ShardObject`); `alchemy-classes.test.ts` type-checks them against the real classes.
- **The shard holds no binding.** A shard answers its leased rooms and the publishing room pokes them (through its own namespace, `Workers.DurableObjectScope`). Two Alchemy Durable Object layers cannot each require the other's class, so a shard that called rooms would make the layers cyclic.

## Invariants

- **WebSockets carry only contentless poke frames**; data moves over stateless HTTP, so hibernated sockets cost nothing between writes.
- **Every shard call, room poke and lease registration is bounded** by `publishTimeout`: a hung shard drops its poke, it never holds a push open. Alchemy's RPC stubs take no abort signal, so a call past the bound is abandoned, not aborted.
- **A stub's RPC can fail with `RpcCallError` although its types say `never`**: every call through a stub is fire-and-forget (`DurableFanoutBroker`'s `call`), never trusted to succeed.
- **The provider reports a failed storage or D1 call as a defect**; `DurableCvrStore` and `D1Executor` turn it into `StoreError` / `BackendError`.
- **D1 has no interactive transactions**: the executor reports `transactional: false`, so the SQL backend runs each handler and then bumps its mutation id, not atomically. This does not meet Backend guarantee 1 (#342, #353); the `D1Executor.ts` header says what that costs. Don't document D1 as transactional.
- **A room answers a route by the request path's last segment** (`RoomProtocol.routeOf`): `routeSync` forwards the request unchanged, base path included, because Alchemy's stub forwards the platform request as it is.

## Tests

`src/__tests__/` (Vitest project `alchemy-cloudflare`, kept apart so CI runs it at this package's own `effect` floor). No workerd: `harness.ts` stubs Alchemy at the service seam — the provider's own state and storage adapters (`Workers.fromDurableObjectState`) over in-memory raw fakes, namespaces as in-process RPC dispatch, each call given the object's state and a `RuntimeContext` as the Durable Object bridge gives them.
