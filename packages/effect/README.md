# @thomasfosterau/legation-effect

An offline-first sync engine over a typed resource graph: Node (with its Edges), Collection, declarative Query reads, named Mutation writes, one Client per thread and one Server per backend.

Writes are named, schema-validated intents. They run optimistically on the client, and the server applies them authoritatively. Conflicts resolve by replaying pending intents on top of server state (rebase), not by merge strategies. Reads are declarative queries that compile to sync windows. The server tracks each client's view records (CVRs) and sends minimal row patches. The model is in [CONTEXT.md](../../CONTEXT.md) and [ADR-0022](../../docs/adr/0022-resource-graph-public-api.md).

## Install

```sh
npm install @thomasfosterau/legation-effect effect
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.2` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR). Install one copy of `effect` in your app: two copies break `Context` identity.

## Usage

This is the whole pipeline in one process: a `Server` over the reference in-memory backend, and a `Client` connected to it by a loopback transport.

```ts
import { Effect, Schema, Stream } from "effect";
import {
  Authorization,
  Client,
  Edge,
  MemoryBackend,
  Mutation,
  Node,
  Server,
  Transport,
  type Query,
} from "@thomasfosterau/legation-effect";

// 1. The domain, shared by client and server: a node graph, mutations, reads.
const projects = Node.make("projects", {
  attributes: { name: Schema.String },
  edges: { todos: Edge.many("todos", { inverse: "project" }) },
});
const todos = Node.make("todos", {
  attributes: { title: Schema.String, done: Schema.Boolean },
  // The foreign key is declared once, on the child; `projects.todos` is its inverse.
  edges: { project: Edge.one("projects", { via: "projectId" }) },
  filterable: { done: ["eq"] },
});
const nodes = Node.registry([projects, todos]);

const Project = Schema.Struct({ id: Schema.String, name: Schema.String });
const Todo = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
const setProject = Mutation.make("project/set", Project);
const setTodo = Mutation.make("todo/set", Todo);

// The optimistic (client-side) handlers: they run once when the mutation is
// issued and again on every rebase, so they must be re-runnable.
const mutations = Mutation.registry([
  { mutator: setProject, local: (p, writer) => writer.put("projects", p.id, p) },
  { mutator: setTodo, local: (t, writer) => writer.put("todos", t.id, t) },
]);

const projectsWithTodos: Query.Read = { collection: "projects", include: { todos: true } };
const openTodos: Query.Read = { collection: "todos", where: { done: false } };

const program = Effect.gen(function* () {
  // 2. Server: one per backend. MemoryBackend is the reference backend; its
  //    handlers are the authoritative mutations. Read auth is deny-by-default.
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(setProject, (p, writer) => writer.put("projects", p.id, p)),
      MemoryBackend.handler(setTodo, (t, writer) => writer.put("todos", t.id, t)),
    ])
  );
  const server = yield* Server.make({
    backend,
    auth: {
      policy: Authorization.policy(
        { projects: Authorization.allowAll, todos: Authorization.allowAll },
        { collections: nodes.collections }
      ),
    },
  });

  // 3. Client: one per thread. Here it reaches the server over an in-process
  //    loopback transport; `syncLoop.pushDebounce` pushes writes on its own.
  const client = yield* Client.make({
    nodes,
    mutations,
    clientGroupId: "group-1",
    transport: yield* Transport.makeInMemory(server.handler, "group-1"),
    syncLoop: { pushDebounce: "50 millis" },
  });

  // 4. Reads: `subscribe` pins a read's windows (edges included) so the
  //    replica syncs them; `observe` subscribes for the stream's lifetime.
  yield* client.subscribe(projectsWithTodos);
  yield* Effect.forkScoped(
    client.observe(openTodos).pipe(Stream.runForEach((rows) => Effect.log(`${rows.length} open`)))
  );

  // 5. Writes: applied optimistically now, confirmed by the server later.
  yield* client.mutate("project/set", { id: "p1", name: "Launch" });
  yield* client.mutate("todo/set", { id: "t1", projectId: "p1", title: "Ship it", done: false });

  return yield* client.query(projectsWithTodos);
});

Effect.runPromise(Effect.scoped(program)).then((rows) => console.log(JSON.stringify(rows)));
```

In a real deployment the server runs in a process of its own and the client connects with `transport: { url }`. See [`@thomasfosterau/legation-node`](../node) for the server and [`@thomasfosterau/legation-browser`](../browser) for the browser hosts. The fuller examples are [`examples/todo`](../../examples/todo), one node with optimistic writes and offline use, and [`examples/commerce`](../../examples/commerce), the full deployment.

## API

Everything below is on the root entry, `@thomasfosterau/legation-effect`.

| Export          | What it is                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node`          | A resource type. `Node.make(type, { attributes, edges, filterable, sortable })` defines one; `Node.registry([...])` closes and validates a graph.                                                                                   |
| `Edge`          | A relationship between nodes: `Edge.one` (a foreign key on this node), `Edge.many` (the dependent collection, named by its `inverse`) and `Edge.paginated` (a cursor-windowed collection with a fixed `order`).                     |
| `Collection`    | The named set of one node type that a client materializes. `Node.registry` derives it from the graph.                                                                                                                               |
| `Query`         | The read. `Query.make({ collection, where, include, order, first, after })` declares a read; `Query.named(name, args)` declares a server-resolved named query.                                                                      |
| `Aggregate`     | Read projections over a query: `Aggregate.count`, `Aggregate.sum(field)`, `min`, `max` and `avg`.                                                                                                                                   |
| `Mutation`      | The write. `Mutation.make(name, schema)` declares a named intent; `Mutation.registry` pairs each with its optimistic `local` handler. (`Mutator` is a deprecated alias.)                                                            |
| `Client`        | The one-per-thread object. `Client.make` owns an engine; `Client.connect` joins one hosted elsewhere, such as a service worker. It offers `query`, `observe`, `subscribe`, `mutate`, `mutateWithAck`, `mutationStates` and `reset`. |
| `ClientStore`   | Durable replica and journal storage. `makeMemory` is the default; `makeKeyValue` and `layerKeyValue` wrap any key-value store. The browser package supplies IndexedDB.                                                              |
| `Transport`     | The carrier seam: the `ClientTransport` and `ServerHandler` services, plus `makeInMemory` (loopback), `simulateOffline` and `withFallback`.                                                                                         |
| `Identity`      | The identity boundary. A durable replica belongs to one resolved identity; `Client.make({ identity })` and `client.reset(fingerprint)` enforce it.                                                                                  |
| `Hydration`     | Serialisable snapshots of a client's durable state (`dehydrate`, `hydrate`, `snapshot`), for server rendering and hydration.                                                                                                        |
| `Server`        | One per backend. `Server.make({ backend, auth })` gives the protocol `handler` to mount on a carrier, and `broadcast` announces out-of-band changes.                                                                                |
| `Backend`       | The storage contract you implement: apply mutations transactionally and evaluate a subset. The `Backend` service is what `Server.make` consumes.                                                                                    |
| `MemoryBackend` | The reference in-memory backend, for tests and prototypes: `make`, `layer`, `handler` and `validatedHandlers`.                                                                                                                      |
| `Authorization` | Deny-by-default read filters: `policy` builds them per collection (`allowAll` opts a collection in), and `IdentityResolver` and `SyncMiddleware` hook the request path.                                                             |
| `FilterPolicy`  | The filterable and sortable declarations a node makes, which `Authorization` enforces on client-supplied `where` and `order`.                                                                                                       |
| `Predicate`     | The filter algebra (`eq`, `isIn`, `and`, `or`, `not`, `exists` and others). It is the full form of `Query`'s `where` and the form auth filters take.                                                                                |
| Errors          | Typed errors, including `StoreError`, `TransportError`, `QueryError`, `MutationRejected` and `AuthorizationError`.                                                                                                                  |

### Adapter authors: `@thomasfosterau/legation-effect/internal`

The engine seams live on a second entry point, `@thomasfosterau/legation-effect/internal`: `ClientEngine`, `ClientView`, `Subset`, `Mirror`, `EngineHost`, `MirrorChannel`, `MirrorProtocol`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo` and the protocol and transport codecs. The sibling packages (`@thomasfosterau/legation-browser`, `@thomasfosterau/legation-node`, `@thomasfosterau/legation-jsonapi`, `@thomasfosterau/legation-cloudflare`) compose from it. It is not the app-facing API, and it moves faster than the root entry.

```ts
import { ClientEngine, Subset } from "@thomasfosterau/legation-effect/internal";

// Adapter code is typed against the seams, not the app-facing surface.
export type Engine = ClientEngine.ClientEngine;
export type Plan = Subset.Subset;
```

## License

MIT
