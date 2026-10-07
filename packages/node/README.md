# @thomasfosterau/legation-node

Node-runtime adapter for the legation engine. `HttpSyncServer` serves the default RPC sync transport on Node's HTTP server, over HTTP POST, WebSockets or both.

## Install

```sh
npm install @thomasfosterau/legation-node @thomasfosterau/legation-effect effect @effect/platform-node
```

`@effect/platform-node` declares a peer on `redis` (`>=5.0.0 <7.0.0`), so a package manager that checks peers may warn when it is missing. This package doesn't need it: it imports `@effect/platform-node/NodeHttpServer` by subpath, never the package root (whose `NodeRedis` re-export imports `redis` at module load), so it loads without `redis` installed. If your app skips peers (`--legacy-peer-deps`, `auto-install-peers=false`), import by subpath in your own code too (`@effect/platform-node/NodeRuntime`, …): without `redis`, the root fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'redis'`.

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. `@effect/platform-node` is peered with the same floor. Tested against `4.0.0` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR). Install one copy of `effect` in your app: two copies break `Context` identity.

Requires Node.js 22 or newer (`engines.node: ">=22"`), the published floor. CI tests on the latest stable Node.

## Usage

The shared domain, imported by both the server and the client:

```ts
// domain.ts
import { Schema } from "effect";
import { Mutation, Node } from "@thomasfosterau/legation-effect";

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
const { id: _id, ...attributes } = Todo.fields;
export const nodes = Node.registry([Node.make("todos", { attributes })]);

export const setTodo = Mutation.make("todo/set", Todo);
export const mutations = Mutation.registry([
  { mutator: setTodo, local: (todo, writer) => writer.put("todos", todo.id, todo) },
]);
```

The server. It provides a `Transport.ServerHandler` (the `Server`'s protocol handler) and serves the sync RPCs on two paths, one per carrier:

```ts
// server.ts
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Authorization, MemoryBackend, Server, Transport } from "@thomasfosterau/legation-effect";
import { HttpSyncServer } from "@thomasfosterau/legation-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { nodes, setTodo } from "./domain.js";

// The one server-side object, provided as the ServerHandler the routes serve.
const SyncServerLive = Layer.effect(Transport.ServerHandler)(
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(
      MemoryBackend.validatedHandlers([
        MemoryBackend.handler(setTodo, (todo, writer) => writer.put("todos", todo.id, todo)),
      ])
    );
    const server = yield* Server.make({
      backend,
      auth: {
        policy: Authorization.policy(
          { todos: Authorization.allowAll },
          { collections: nodes.collections }
        ),
      },
    });
    return server.handler;
  })
);

// Both carriers, on the paths `Client.make`'s `transport: { url }` expects.
const SyncRoutes = Layer.mergeAll(
  HttpSyncServer.layerWebSocket({ path: "/sync-ws" }),
  HttpSyncServer.layerHttp({ path: "/sync" })
);

const Main = HttpRouter.serve(SyncRoutes).pipe(
  Layer.provide(SyncServerLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3100 }))
);

NodeRuntime.runMain(Layer.launch(Main));
```

The client. It runs in a browser, in a worker, or on Node, which provides a global `WebSocket`:

```ts
// client.ts
import { Client } from "@thomasfosterau/legation-effect";
import { Effect } from "effect";
import { mutations, nodes } from "./domain.js";

const program = Effect.gen(function* () {
  const client = yield* Client.make({
    nodes,
    mutations,
    clientGroupId: "todo-group",
    // Sync RPCs over WebSocket at /sync-ws, falling back to HTTP POST at /sync.
    transport: { url: "http://localhost:3100" },
    syncLoop: { pushDebounce: "300 millis", pullInterval: "15 seconds" },
  });
  yield* client.subscribe({ collection: "todos" });
  yield* client.mutate("todo/set", { id: "1", title: "over the wire", done: false });
  yield* Effect.sleep("2 seconds"); // give the sync loop time to push and pull
  return yield* client.query({ collection: "todos" });
});

Effect.runPromise(Effect.scoped(program)).then((rows) => console.log(JSON.stringify(rows)));
```

Start `server.ts`, then run `client.ts`. The write is applied locally at once, and the sync loop pushes it after the debounce.

Two details matter when you wire this up:

- `HttpSyncServer.layerWebSocket` and `layerHttp` each register the sync RPCs on an `HttpRouter` at the `path` you give. They need a `Transport.ServerHandler` in context, and `HttpRouter.serve` plus a listener (here `NodeHttpServer.layer`) turn the routes into a running server.
- `Client.make({ transport: { url } })` speaks to `<url>/sync-ws` for the live path (pokes arrive over it) and falls back to `<url>/sync` for HTTP POST. Serve the paths the client uses.

## API

| Export                                   | What it is                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpSyncServer.layerHttp(options)`      | A layer that registers the sync RPCs at `options.path` over the HTTP POST protocol. Requires `Transport.ServerHandler` and `HttpRouter`.                                           |
| `HttpSyncServer.layerWebSocket(options)` | The same RPCs at `options.path` over the WebSocket protocol, for live pokes.                                                                                                       |
| `HttpSyncServer.layerServe(options)`     | `layerHttp` plus `HttpRouter.serve` and a Node listener in one layer, for an HTTP-only server on `options.port` (and optional `options.host`). Requires `Transport.ServerHandler`. |
| `HttpSyncServer.HttpSyncServerOptions`   | `path`, the route the sync RPCs are served on, and an optional `serialization` layer. Wire framing defaults to NDJSON (`RpcSerialization.layerNdjson`).                            |
| `HttpSyncServer.ListenOptions`           | `HttpSyncServerOptions` plus `port` and an optional `host`, for `layerServe`.                                                                                                      |

The engine behind the handler is `@thomasfosterau/legation-effect`'s `Server`: build it with `Server.make({ backend, auth })`, provide `server.handler` as the `Transport.ServerHandler`, and mount it with one of the layers above. The `commerce` example runs a real sync server this way: [`examples/commerce`](../../examples/commerce).

## License

MIT
