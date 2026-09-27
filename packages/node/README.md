# @legation/node

Node-runtime adapters for the [legation](https://github.com/thomasfosterau/legation) engine.

This package contains the server-side **WebSocket transport**: it accepts WebSocket connections (via the [`ws`](https://www.npmjs.com/package/ws) package) and exposes each connected client as a core `Transport.ServerConnection`, ready to be driven by a `SyncHub`.

Per [ADR-0006](../../docs/adr), runtime code that depends on Node-only APIs lives here rather than in the runtime-agnostic `@legation/effect`.

## Install

```sh
bun add @legation/node @legation/effect effect
```

`ws` is bundled as a dependency; `effect` is a peer dependency.

**Install `redis` too.** `@effect/platform-node` (a peer of this package)
declares a **non-optional** peer on `redis` (`>=5.0.0 <7.0.0`), and it means
it: its root entry re-exports `NodeRedis`, which imports `redis` at module
load, and this package imports that root entry. Under Node's ESM loader a
missing `redis` therefore fails at import (`ERR_MODULE_NOT_FOUND: Cannot find
package 'redis'`) even though nothing here uses Redis. npm, bun and pnpm
(with its default `auto-install-peers`) install the peer for you; a setup that
skips peers (`--legacy-peer-deps`, `auto-install-peers=false`) must add it:

```sh
bun add redis
```

## Effect version

Peers `effect >=4.0.0-rc.113`, the floor shared with `@thomasfosterau/effect-jsonapi` and `@thomasfosterau/effect-auth`. `@effect/platform-node` is peered with the same floor. Tested against `4.0.0-rc.113` (the floor) and `4.0.0-rc.115` (the version CI pins); install one copy of `effect` in your app (ADR-0003).

Requires Node.js 22 or newer (`engines.node: ">=22"`), the Node line CI runs.

## Quick start

Compose the in-memory `ServerStore` and `SessionRegistry` into a `SyncHub`, then `serve` a WebSocket server that feeds every incoming connection into the hub:

```ts
import { Effect, Layer } from "effect";
import { ServerStore, Sessions, SyncHub } from "@legation/effect";
import { WebSocketServer } from "@legation/node";

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

Browser clients use the matching `WebSocketTransport` from [`@legation/browser`](../browser), which speaks the same one-JSON-message-per-frame wire format. Any client that can open a WebSocket and send/receive JSON protocol messages will interoperate — including the platform-global `WebSocket` available in Node 22+ (used by this package's own tests).

## API

- `WebSocketServer.make(options)` — start a server (scoped); exposes `address`, a `connections` stream, and `shutdown`.
- `WebSocketServer.serve(options)` — start a server and feed every connection into the `SyncHub`; returns `{ port }`. Requires `SyncHub` in context.

`options` is `{ port: number; host?: string }` (default host `"0.0.0.0"`; use `port: 0` for an ephemeral port).

## License

MIT
