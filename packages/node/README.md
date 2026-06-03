# @thomasfosterau/effect-sync-node

Node-runtime adapters for the [effect-sync](https://github.com/thomasfosterau/effect-synchronizer) engine.

This package contains the server-side **WebSocket transport**: it accepts WebSocket connections (via the [`ws`](https://www.npmjs.com/package/ws) package) and exposes each connected client as a core `Transport.ServerConnection`, ready to be driven by a `SyncHub`.

Per [ADR-0006](../../docs/adr), runtime code that depends on Node-only APIs lives here rather than in the runtime-agnostic `@thomasfosterau/effect-sync-core`.

## Install

```sh
bun add @thomasfosterau/effect-sync-node @thomasfosterau/effect-sync-core effect
```

`ws` is bundled as a dependency; `effect` is a peer dependency.

## Quick start

Compose the in-memory `ServerStore` and `SessionRegistry` into a `SyncHub`, then `serve` a WebSocket server that feeds every incoming connection into the hub:

```ts
import { Effect, Layer } from "effect";
import { ServerStore, Sessions, SyncHub } from "@thomasfosterau/effect-sync-core";
import { WebSocketServer } from "@thomasfosterau/effect-sync-node";

const hubLayer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

const program = Effect.gen(function* () {
  const { port } = yield* WebSocketServer.serve({ port: 3000 });
  yield* Effect.log(`sync server listening on ${port}`);
  // Keep the server alive until interrupted; the scope owns the server.
  yield* Effect.never;
});

Effect.runFork(Effect.scoped(program.pipe(Effect.provide(hubLayer))));
```

`serve` returns once the server is listening (use `port: 0` for an ephemeral port and read the resolved port from the result). The accept loop runs in the background; each connection is handled on its own fiber so one slow client cannot block the others. Closing the surrounding scope shuts the server down and terminates every live client connection.

### Lower-level: `make`

If you want to wire connections up yourself (for example to authenticate before registering a session), use `make`, which hands back a stream of `ServerConnection`s:

```ts
const server = yield * WebSocketServer.make({ port: 0 });
const { port } = yield * server.address;
yield *
  Stream.runForEach(server.connections, (connection) =>
    Effect.forkScoped(hub.handleConnection(connection))
  );
```

## Wire format

Each WebSocket **text** message is exactly one JSON-encoded protocol message:

- incoming frames are schema-validated by core's `ProtocolSchema.parseClientMessage` into a
  core `ClientMessage`;
- outgoing frames are serialized with `JSON.stringify` from a core `ServerMessage`.

Binary frames and frames that fail schema validation are logged and skipped (they do not
crash the connection).

## Connecting clients

Browser clients use the matching `WebSocketTransport` from [`@thomasfosterau/effect-sync-browser`](../browser), which speaks the same one-JSON-message-per-frame wire format. Any client that can open a WebSocket and send/receive JSON protocol messages will interoperate — including the platform-global `WebSocket` available in Node 22+ (used by this package's own tests).

## API

- `WebSocketServer.make(options)` — start a server (scoped); exposes `address`, a `connections` stream, and `shutdown`.
- `WebSocketServer.serve(options)` — start a server and feed every connection into the `SyncHub`; returns `{ port }`. Requires `SyncHub` in context.

`options` is `{ port: number; host?: string }` (default host `"0.0.0.0"`; use `port: 0` for an ephemeral port).

## License

MIT
