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
- **`BindingTransport`** — the same protocol over a **service binding**
  (`env.API.fetch`), for the two-Worker shape where the Worker rendering the
  page is not the Worker holding the backend. It forwards the inbound cookie
  and origin, so the bound Worker resolves the same caller — and therefore the
  same room — that the browser will reach on its own first pull.

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

## Install

```sh
npm install @legation/cloudflare @legation/effect @legation/sql effect
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.0-rc.118` (both the floor and the version CI pins); install one copy of `effect` in your app (ADR-0003).

## SSR from a separate Worker

A binding-only API Worker (`workersDev: false`, no custom domain) is reachable
only through the front door's service binding, so an SSR render cannot hold the
sync server in-process. `Hydration.snapshot` takes a `ClientTransport`; give it
a `BindingTransport` and the render pulls over the binding:

```ts
// +page.server.ts — the effect an Effect-based `load` runs
import { BindingTransport } from "@legation/cloudflare";
import { loadSnapshot } from "@legation/svelte/kit";

const pageSnapshot = ({ cookies, request, platform }) =>
  loadSnapshot(cookies, {
    nodes,
    reads: [{ collection: "products" }],
    transport: BindingTransport.make({
      binding: platform.env.API,
      request, // the document request: its cookie and origin are forwarded
    }),
  });
```

The render happens under the _browser's_ client group id, so the snapshot's
pull cookie continues that group's CVR conversation and the browser's first
pull is a delta rather than a reset. That only holds while the hop preserves
the caller's identity — drop the cookie and the snapshot still carries the
right rows while its cookie belongs to another room's CVR, which is a silent
reset on every first paint. `binding-snapshot.test.ts` pins both sides of that.

## License

MIT
