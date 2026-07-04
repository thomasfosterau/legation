# @legation/cloudflare

The reference deployment of the [`@legation/effect`](../effect) sync engine on
Cloudflare — per-user Durable Object rooms, topic-sharded fan-out, and a D1
backend — following ADR-0022 (topology) and ADR-0023 (topic-derived fan-out).

- **`Room` (`makeRoomClass`)** — the per-user Durable Object. It runs the sync
  `Server` for one user: push/pull/read over stateless HTTP (each request wakes
  the object, is answered, and lets it hibernate), CVRs in the object's
  transactional storage (co-located with the user), a `FanoutBus` over the
  topic shards, and WebSockets that carry only contentless poke frames — so
  hibernated sockets cost nothing between writes.
- **`FanoutShard` (`makeShardClass`)** — one Durable Object per topic
  (`idFromName(topic)` is the shard function). Rooms lease their topics on a
  heartbeat; a publish pokes every live room and ages out expired leases
  lazily, so a crashed room needs no distributed cleanup.
- **`Worker` (`routeSync`)** — the stateless entry. It claims only the sync
  base path (default `/sync`), resolves the caller's identity to their room,
  forwards the route (WebSocket upgrades included), and returns `undefined`
  for everything else, so it composes inside any existing fetch handler.
- **`D1Executor`** — a `SqlBackend` executor over a Cloudflare D1 binding.
  Prefer single-statement mutation handlers: D1 has no interactive
  transactions, so mutation-id idempotency carries replay safety (Postgres via
  Hyperdrive keeps full transactionality).
- **`RoomTransport`** — the browser-side `ClientTransport`: push/pull/read as
  HTTP POSTs plus one reconnecting poke socket. Sync stays correct over HTTP
  alone — a dead socket only delays pokes, and the pull interval is the safety
  net.

```ts
// worker.ts
import { Authorization, Node } from "@legation/effect";
import { SqlBackend } from "@legation/sql";
import { D1Executor, FanoutShard, Room, Worker } from "@legation/cloudflare";

export class LegationShard extends FanoutShard.makeShardClass({
  rooms: (env) => env.ROOMS,
}) {}

export class LegationRoom extends Room.makeRoomClass({
  nodes,
  backend: (env) => SqlBackend.make({ executor: D1Executor.make(env.DB), nodes }),
  policy: () =>
    Authorization.policy({
      /* … */
    }),
  shards: (env) => env.SHARDS,
}) {}

const route = Worker.routeSync({
  rooms: (env) => env.ROOMS,
  roomIdOf: (request, env) => resolveSession(request, env),
});

export default {
  async fetch(request, env) {
    return (await route(request, env)) ?? app.fetch(request, env);
  },
};
```

```bash
npm install @legation/cloudflare @legation/effect @legation/sql effect
```
