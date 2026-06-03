# @thomasfosterau/effect-sync-server

Server-side write-through sync engine with client fan-out, built on
[Effect](https://effect.website). It is the server half of the
`@thomasfosterau/effect-sync-core` wire protocol: it accepts connected
clients, applies their pushed mutations write-through to a backing store
(the source of truth), and broadcasts the resulting changes to every other
subscribed client.

## Architecture

```text
                           ┌──────────────────────────────┐
   client A ──push────────▶│            SyncHub           │──set──▶ ServerStore
                           │  (write-through + fan-out)   │        (source of truth)
   client B ◀───Updated────│                              │◀── publish() / remove()
   client C ◀───Updated────│   SessionRegistry (who's in) │    invalidate()
                           └──────────────────────────────┘   (server-initiated writes)
```

- **`ServerStore`** — the authoritative, versioned backing store. Each key
  carries a monotonically increasing version (starting at 1). The bundled
  `memoryLayer` is a `Map`-backed implementation; production deployments
  implement the same interface over their database of record.
- **`SessionRegistry`** — tracks connected clients and the key filters each
  has subscribed to, so the hub knows who should receive a notification.
- **`SyncHub`** — the engine. It dispatches incoming `ClientMessage`s,
  performs write-through with optimistic-concurrency conflict detection, and
  fans out `Updated` / `Removed` / `Invalidated` notifications.

## Effect quick start

Wire a connected client into the hub. A `ServerConnection` comes from your
transport (WebSocket, SSE, `Transport.makeInMemoryPair`, …).

```ts
import { Effect, Layer } from "effect";
import { Transport } from "@thomasfosterau/effect-sync-core";
import { ServerStore, Sessions, SyncHub } from "@thomasfosterau/effect-sync-server";

const ServerLayer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

const program = (connection: Transport.ServerConnection) =>
  Effect.gen(function* () {
    const hub = yield* Effect.service(SyncHub.SyncHub);
    // Runs until the connection closes; cleans up the session on exit.
    yield* hub.handleConnection(connection);
  });

// For each new connection, fork `program(connection)` on your runtime,
// providing `ServerLayer`.
```

## Write-through semantics

When a client sends a `Push`, the hub applies each mutation write-through:

1. Read the current entry for the key from `ServerStore`.
2. Conflict check (below).
3. On success, `store.set(key, input)` bumps the version and the canonical
   entry is returned to the pusher in the `PushAck` as an `Applied` result.
4. The new entry is fanned out as `Updated` to every **other** subscribed
   session. The pushing session is excluded — it already learns the outcome
   from its `PushAck`.

Server-initiated writes use the same store and fan-out path:

```ts
Effect.gen(function* () {
  const entry = yield* hub.publish(["users", "1"], { name: "Ada" }); // fan-out Updated to all subscribers
  yield* hub.remove(["users", "1"]); // fan-out Removed
  yield* hub.invalidate(Protocol.prefixFilter(["users"])); // fan-out Invalidated
});
```

Fan-out is concurrent and best-effort: each send is isolated, so a single
dead client cannot block delivery to the others.

## Conflict detection

A `Push` mutation may carry a `baseVersion` — the version the client last
observed for the key. If `baseVersion` is set, the key exists in the store,
and the stored version differs, the mutation is **not** applied. Instead the
hub returns a `Conflict` result carrying the server's current authoritative
entry, so the client can rebase and retry:

```ts
// PushResult for a stale write:
// { _tag: "Conflict", mutationId, key, serverEntry: { version, value, ... } }
```

Mutations without a `baseVersion`, or against keys that do not yet exist,
are applied unconditionally (last-write-wins create/update).

## Promise facade

For non-Effect host code (Express/Fastify handlers, plain WebSocket
servers, serverless functions), `makeSyncServer()` wires the default
in-memory layers and exposes promise-returning methods:

```ts
import { Facade } from "@thomasfosterau/effect-sync-server";

const server = Facade.makeSyncServer();

// Drive a connection (resolves when it closes):
void server.handleConnection(connection);

await server.publish(["users", "1"], { name: "Ada" });
await server.remove(["users", "1"]);
await server.invalidate({ _tag: "Prefix", prefix: ["users"] });
const count = await server.connectedSessions();

await server.dispose(); // tear down the runtime
```

For control over the backing store (e.g. a real database) or layer
composition, use the Effect-native `SyncHub` service directly.

## License

MIT
