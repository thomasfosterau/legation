# ADR-0034: The Cloudflare adapter is built on Alchemy's Cloudflare provider

Date: 2026-11-06
Status: Accepted. Amends in part [ADR-0022](0022-resource-graph-public-api.md) and [ADR-0023](0023-topic-derived-fanout.md) (the `@thomasfosterau/legation-cloudflare` adapter they name, and ADR-0023's shard-pokes-rooms delivery), and the last bullet of [ADR-0033](0033-owner-libraries-count-runtimes-do-not.md)'s "Applied now".

## Context

`@thomasfosterau/legation-cloudflare` (never published) implemented ADR-0022's
reference topology — per-user room Durable Objects, topic-sharded fan-out
Durable Objects, a stateless router and a D1 executor — against the raw workerd
types (`@cloudflare/workers-types`, an optional peer): `makeRoomClass` and
`makeShardClass` returned plain Durable Object classes with `fetch` handlers,
and every call between objects was an HTTP request to a stub.

The apps that consume legation deploy with [Alchemy](https://alchemy.run),
whose Cloudflare provider (`@alchemy.run/cloudflare`) declares Workers and
Durable Objects as Effect programs and gives them Effect-native services:
`Cloudflare.DurableObjectState` (storage, hibernatable WebSockets, alarms),
typed RPC stubs on `Cloudflare.DurableObject` namespaces, and
`Cloudflare.D1.QueryDatabase`. An adapter written against workerd's classes
cannot be bound into those programs: an Alchemy app would have to host it as an
async class beside its Effect code, bind its namespaces by hand and give up the
typed stubs. ADR-0033 recorded the owner's decision to replace the package with
an Alchemy-based one.

## Decision

- **`@thomasfosterau/legation-alchemy-cloudflare` replaces
  `@thomasfosterau/legation-cloudflare`**, named for the Alchemy provider it is
  built on (one package per Alchemy provider, as in the owner's other
  libraries).
- **It peers on `alchemy` and `@alchemy.run/cloudflare` exactly
  (2.0.0-beta.85)**, the release the apps pin, and on `effect ^4.1.0`, which
  Alchemy requires (`catalogs.alchemy-peers`). The rest of legation keeps
  `effect ^4.0.0`. The workspace's dev pin moves to the 4.1 line, since
  `effect` is a singleton there.
- **It is written against the provider's services, not workerd's types.** The
  room and the shard are Alchemy Durable Object implementations
  (`Room.make(config)`, `FanoutShard.make`) that the app binds to classes it
  declares (`LegationRoom.make(...)`); their state, storage and sockets are
  `Cloudflare.DurableObjectState`'s; the D1 executor runs statements through
  `QueryDatabaseClient`; the router forwards through the room namespace's stub.
  `@cloudflare/workers-types` stops being a peer.
- **Calls between objects are typed RPC.** The shard's surface is
  `register(roomId, ttlMillis)` and `publish()`; the room's is `poke(topics)`.
  The publishing room now pokes the leased rooms itself, from the room ids the
  shards answer, instead of the shard poking them: Alchemy provides each
  Durable Object's layer the classes it needs, so a shard that needed the room
  class and a room that needed the shard class would be a cycle. A room leased
  on several of a write's topics is poked once, with all of them, and a room's
  own lease is delivered locally.
- **The app declares the classes.** A class declaration is a top-level call,
  which the package's `"sideEffects": false` rules out in `dist/`; the package
  exports the implementations and the surfaces they satisfy.

## Consequences

- Kept from the old package, because the provider does not cover it: D1 still
  has no interactive transactions (`transactional: false`, #342, #353); the
  transports and the edge-invalidation sinks stay structural (`fetch`, a KV
  `delete`, `cache.purge`), with no workerd types to replace.
- Changed by the provider: a shard or room call past `publishTimeout` is
  abandoned rather than aborted, since Alchemy's RPC stubs take no abort
  signal; and a stub's call can fail with `RpcCallError` although its types
  say `never`, so the broker treats every call as fire-and-forget.
- The package's tests stub Alchemy at the service seam (the provider's own
  state and storage adapters over in-memory fakes) and run as their own Vitest
  project, so CI tests them at their own `effect` floor (4.1.0) and the rest of
  the workspace at 4.0.0.
- The apps adopt it with the release that ships it (gardeneria#1265's
  `DurableCvrStore` / `DurableFanoutBroker` plan), on alchemy 2.0.0-beta.85.
