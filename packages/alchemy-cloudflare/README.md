# @thomasfosterau/legation-alchemy-cloudflare

The reference deployment of the [`@thomasfosterau/legation`](../effect) sync engine on
Cloudflare — per-user Durable Object rooms, topic-sharded fan-out, and a D1
backend — following ADR-0022 (topology) and ADR-0023 (topic-derived fan-out),
built on the Effect-native services of [Alchemy](https://alchemy.run)'s
Cloudflare provider, `@alchemy.run/cloudflare` (ADR-0034). The Durable Objects
are Alchemy Durable Objects, their state, storage and sockets are the provider's
`Cloudflare.DurableObjectState`, and the D1 executor runs through its
`Cloudflare.D1.QueryDatabase` client.

- **`Room`** — the per-user Durable Object (`LegationRoom.make(Room.make(...))`).
  It runs the sync `Server` for one user: push/pull/read over stateless HTTP
  (each request wakes the object, is answered, and lets it hibernate), CVRs in
  the object's transactional storage (`DurableCvrStore`, co-located with the
  user), a `FanoutBus` over the topic shards, and hibernatable WebSockets
  (`Cloudflare.upgrade`) that carry only contentless poke frames — so hibernated
  sockets cost nothing between writes. Each shard call, room poke and lease
  registration is bounded by `publishTimeout` (default 5 seconds): a hung shard
  is dropped with its poke, so it cannot hold a push open, and a lost poke only
  delays the next pull.
- **`FanoutShard`** — one Durable Object per topic (`getByName(topic)` is the
  shard function), with a typed RPC surface (`register`, `publish`). Rooms lease
  their topics on a heartbeat; a publish answers every live room, and the
  publishing room pokes them (one `poke` RPC per room, carrying every topic it
  matched). Expired leases age out lazily, so a crashed room needs no
  distributed cleanup.
- **`Worker` (`routeSync`)** — the stateless entry, for an Alchemy Worker's
  `fetch`. It claims only the sync base path (default `/sync`), resolves the
  caller's identity to their room (or, opted in, an anonymous caller to a shared
  anonymous room), forwards the request to the room's stub
  (WebSocket upgrades included), and answers `Option.none()` for everything
  else, so it composes inside any existing handler.
- **`D1Executor`** — a `SqlBackend` executor over the `QueryDatabaseClient` of
  `Cloudflare.D1.QueryDatabase`. D1 has no interactive transactions, so a
  mutation's writes and its mutation-id bump commit separately, and D1 isolates
  no handler's reads from another client group's writes: SqlBackend on D1 does
  not meet Backend guarantee 1 (#342, #353). For apps that need it, use Durable
  Object storage or Postgres via Hyperdrive; on D1, prefer single-statement,
  idempotent handlers.
- **`RoomTransport`** — the browser-side `ClientTransport`: push/pull/read as
  HTTP POSTs plus one reconnecting poke socket. Sync stays correct over HTTP
  alone — a dead socket only delays pokes, and the pull interval is the safety
  net.
- **`BindingTransport`** — the same protocol over a **service binding**
  (`env.API.fetch`), for the two-Worker shape where the Worker rendering the
  page is not the Worker holding the backend. It forwards the inbound cookie
  and origin, so the bound Worker resolves the same caller — and therefore the
  same room — that the browser will reach on its own first pull.

## Install

```sh
npm install @thomasfosterau/legation-alchemy-cloudflare @thomasfosterau/legation effect \
  alchemy@2.0.0-beta.85 @alchemy.run/cloudflare@2.0.0-beta.85
npm install --save-dev @cloudflare/workers-types
```

`alchemy` and `@alchemy.run/cloudflare` are peers at exactly 2.0.0-beta.85 (each
`@alchemy.run/*` release pins `alchemy` exactly). `@cloudflare/workers-types` is
not a peer of this package: the provider's own declarations import it, so a
Worker project type-checks with it installed.

## Usage

The app declares its two Durable Object classes and binds this package's
implementations to them; the Worker hosting them provides both layers.

```ts
// sync.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Authorization } from "@thomasfosterau/legation";
import { SqlBackend } from "@thomasfosterau/legation/sql";
import { D1Executor, FanoutShard, Room } from "@thomasfosterau/legation-alchemy-cloudflare";

export class LegationShard extends Cloudflare.DurableObject<
  LegationShard,
  FanoutShard.ShardObject
>()("LegationShard") {}

export class LegationRoom extends Cloudflare.DurableObject<LegationRoom, Room.RoomObject>()(
  "LegationRoom"
) {}

export const LegationShardLive = LegationShard.make(FanoutShard.make);

export const LegationRoomLive = LegationRoom.make(
  Effect.gen(function* () {
    // Bindings resolve at init; the room builds its server per instance.
    const db = yield* Cloudflare.D1.QueryDatabase(AppDatabase);
    return yield* Room.make({
      nodes,
      backend: Effect.map(D1Executor.make(db), (executor) => SqlBackend.make({ executor, nodes })),
      policy: Effect.succeed(Authorization.policy({/* … */})),
      shards: LegationShard,
    });
  })
);
```

```ts
// worker.ts — the Worker that hosts both classes and routes /sync to the rooms
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Worker } from "@thomasfosterau/legation-alchemy-cloudflare";

export default Api.make(
  Effect.gen(function* () {
    const rooms = yield* LegationRoom;
    return {
      fetch: Effect.gen(function* () {
        const routed = yield* Worker.routeSync({ rooms, roomIdOf: resolveSession });
        return Option.isSome(routed) ? routed.value : yield* app;
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(LegationRoomLive, LegationShardLive)))
);
```

`Room.make`'s `backend`, `policy`, `identity` and `queries` are effects run in
the room's per-instance phase, where the object's state and Alchemy's
`RuntimeContext` are available, so a backend over D1 (or any other binding)
is built there. A request reaches the room with its base path intact, and the
room answers by the path's last segment (`/sync/push` is the `push` route).

### Anonymous readers

`roomIdOf` answering `undefined` is a 401. To serve public collections to
anonymous readers, give `routeSync` an `anonymousRoomOf`: it names the shared
room an anonymous caller uses, under the reserved `Worker.anonymousRoomPrefix`,
so an anonymous caller never reaches a user's room (and a `roomIdOf` id with
that prefix is refused with a 500). `Worker.shardByClientGroup` spreads them
over a fixed number of rooms by their client-group cookie, so one Durable
Object is not their ceiling:

```ts
Worker.routeSync({
  rooms,
  roomIdOf: resolveSession,
  anonymousRoomOf: Worker.shardByClientGroup({ shards: 16 }),
});
```

A group always lands in the same room, so its CVRs stay there. A caller with
no `legation-client-group` cookie (the SvelteKit adapter's `clientGroupId`
sets it) gets a 401. Changing `shards` moves most groups, whose next pull is
then a reset. The room's policy sees these callers as anonymous, so it must
allow only the public collections to the anonymous identity.

The room presents each push, pull and read request's headers to `identity` as
its `Authorization.RequestCredentials` (ADR-0035), so a resolver can verify the
session cookie or API key the request carried: `routeSync` forwards the request
unchanged, and a `BindingTransport` forwards the document request's cookie.

```ts
identity: Effect.succeed({
  resolve: ({ credentials }) =>
    Option.match(credentials.header("cookie"), {
      onNone: () => Effect.succeed(undefined), // anonymous
      onSome: (cookie) => verifySession(cookie), // your own check
    }),
}),
```

Only the resolver sees the headers; auth filters and mutators see the identity
it returns on `SyncContext.identity`.

## Writes that bypass the rooms

A cron or queue Worker that writes rows itself, with no mutation, publishes
the write's `ChangeHint`s with `DurableFanoutBroker.publishOutOfBand`, and
every room leased on the derived topics is poked, as after a push:

```ts
const publish = DurableFanoutBroker.publishOutOfBand({
  shards: yield * LegationShard,
  rooms: yield * LegationRoom,
  nodes,
});
// after the write commits
yield * publish([{ collection: "results", ids, values }]);
```

Pass the written rows as `values` (and the previous ones as `oldValues` for a
row that moved or was deleted): a hint without values derives only the
collection's coarse topic, so a room whose window leased a fine topic (an
equality on an edge or hint key) waits for its next interval pull. Each call is
bounded by `timeout` (default 5 seconds) and fire-and-forget.

`Room.make` also takes `hints`, a `HintSource` the room runs on its bus. A
polling source (`PollingHintSource`) keeps the room awake: its timer stops the
room hibernating, so it is billed between requests, it polls only while the
instance is in memory, and every awake room polls and publishes the same
change. Prefer publishing from the writer.

## PostgreSQL inside a room

A client built in `backend` outlives the request: the room builds its backend
once per in-memory instance and serves every request with it until the
instance is evicted; a wake builds a new one. `backend` runs in the instance's
scope, so `Layer.build(PgClient.layer(...))` there holds a pool for the
instance's life. That scope is never closed: on eviction the connections are
dropped, not closed.

- **Direct connection** (PostgreSQL or PgBouncer): build the pool in `backend`,
  never as a layer on the room class or its Worker (Alchemy builds those once
  per isolate and shares them across rooms). Keep it small (every awake room
  holds one) and give it an idle timeout.
- **Hyperdrive**: don't hold it across requests. Its credentials are valid
  only within the invocation that read them, and the room has no per-request
  backend yet (#506).

Details: [`docs/alchemy-postgres.md`](../../docs/alchemy-postgres.md).

## What Alchemy does not cover

- **Interactive transactions on D1.** The provider's client has `batch()`
  (statements in one implicit transaction) but nothing interactive, so the
  executor reports `transactional: false`, as before.
- **Aborting a shard or room call.** Alchemy's RPC stubs take no abort signal.
  A call past `publishTimeout` is abandoned, not aborted: the room stops
  waiting for it and workerd cancels it with the event that made it.
- **The `/socket` upgrade in tests.** `Cloudflare.upgrade` needs workerd's
  `WebSocketPair` and a 101 response, which Node lacks; the tests accept a fake
  socket directly.

## Effect version

Peers `effect ^4.1.0`, the floor Alchemy requires (`alchemy` and
`@alchemy.run/cloudflare` 2.0.0-beta.85 peer `effect ^4.1.0`). Tested against
`4.1.2` (the version CI pins) and `4.1.0` (the floor; CI runs this package's
tests against it on every PR); install one copy of `effect` in your app
(ADR-0003). The rest of legation peers `effect ^4.0.0`.

## SSR from a separate Worker

A binding-only API Worker (`workersDev: false`, no custom domain) is reachable
only through the front door's service binding, so an SSR render cannot hold the
sync server in-process. `Hydration.snapshot` takes a `ClientTransport`; give it
a `BindingTransport` and the render pulls over the binding:

```ts
// +page.server.ts — the effect an Effect-based `load` runs
import { BindingTransport } from "@thomasfosterau/legation-alchemy-cloudflare";
import { loadSnapshot } from "@thomasfosterau/legation-svelte/kit";

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

## Evicting server-side caches on a write

`EdgeInvalidation` turns the hints a committed write publishes into evictions
of the caches an app keeps on Cloudflare (#206): `kv` deletes the
`{collection}:{id}` entry of every touched row from a KV read-through cache, and
`cachePurge` purges the Workers cache by tag, with the same tag spelling the
browser's Cache API invalidation uses (`collection:{name}`,
`collection:{name}:{id}`, from `HttpCache` in `@thomasfosterau/legation/internal`).
The eviction is no longer an obligation of each mutation: it subscribes to the
bus (`InvalidationSink.run`).

**The cache lives in a different Worker than the write.** `cache.purge({ tags })`
purges only the calling Worker's cache. In the usual shape the front door (the
SvelteKit Worker serving every page) holds the cache, while writes land in the
API Worker behind its service binding. So the API Worker forwards what each
write touched, and the front door runs the sinks:

```ts
// API Worker, where the server and its bus run (a Durable Object room, say)
yield * InvalidationSink.run(EdgeInvalidation.forward(env.FRONT_DOOR));

// Front door Worker: an RPC entrypoint, reachable only through the binding
export class Invalidation extends WorkerEntrypoint<Env> {
  invalidate(payload: string): Promise<void> {
    const sink = InvalidationSink.all([
      EdgeInvalidation.kv(this.env.RESOURCES),
      EdgeInvalidation.cachePurge(this.ctx.cache),
    ]);
    return Effect.runPromise(EdgeInvalidation.receive(sink)(payload));
  }
}
```

Expose the receiving end as an RPC method, not as a route on the front door's
`fetch`: a `fetch` route is reachable from the internet, and anyone could then
purge the cache.

Every eviction is fire-and-forget. A failed KV delete, a failed forward, and a
purge that rejects or resolves `{ success: false }` (which is how `cache.purge`
reports a Cloudflare-side failure, so a `catch` alone misses it) are logged;
none of them fails or delays the write, which committed before its hint was
published. The cache's TTL is the backstop for a lost eviction. A large write is
purged in calls of at most `maxTagsPerPurge` tags (default 30).

## License

MIT
