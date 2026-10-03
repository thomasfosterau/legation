---
"@thomasfosterau/legation-cloudflare": minor
---

New package `@thomasfosterau/legation-cloudflare` — the reference deployment of ADR-0022's topology on Cloudflare, over the `FanoutBroker` seam (ADR-0023).

- **`makeRoomClass`** — the per-user Durable Object. It runs the sync `Server` for one user: push/pull/read over stateless HTTP (each request wakes the object, is answered, and lets it hibernate), CVRs in the object's transactional storage (`DurableCvrStore`, co-located with the user), a `FanoutBus` over the topic shards for cross-room fan-out, and WebSockets that carry exactly one thing — contentless poke frames — so hibernated sockets cost nothing between writes.
- **`makeShardClass`** — one Durable Object per topic (`idFromName(topic)` is the shard function). Rooms lease their topics on a heartbeat; a publish pokes every live room and ages out expired leases lazily, so crashed rooms need no distributed cleanup.
- **`routeSync`** — the stateless Worker router. It claims only the sync base path (default `/sync`), resolves the caller's identity to their room, forwards the route (WebSocket upgrades included), and returns `undefined` for everything else, so it composes inside any existing fetch handler.
- **`D1Executor`** — a `SqlBackend` executor over a Cloudflare D1 binding (single-statement handlers recommended; D1 has no interactive transactions — mutation-id idempotency covers replay, and Postgres via Hyperdrive keeps full transactionality).
- **`RoomTransport`** — the browser-side `ClientTransport`: push/pull/read as HTTP POSTs plus one reconnecting poke socket. Sync stays correct over HTTP alone — a dead socket only delays pokes, and the pull interval is the safety net.

The end-to-end test wires two rooms and topic shards over in-memory Durable Object stubs, drives them with real client engines, and shows a write in one room poking the other's hibernation-style socket and fine-registered window across a shard, while a write to a different parent leaves it silent.
