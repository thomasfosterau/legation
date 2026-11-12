# @thomasfosterau/legation

An offline-first sync engine over a typed resource graph: Node (with its Edges), Collection, declarative Query reads, named Mutation writes, one Client per thread and one Server per backend.

Writes are named, schema-validated intents. They run optimistically on the client, and the server applies them authoritatively. Conflicts resolve by replaying pending intents on top of server state (rebase), not by merge strategies. Reads are declarative queries that compile to sync windows. The server tracks each client's view records (CVRs) and sends minimal row patches. The model is in [CONTEXT.md](../../CONTEXT.md) and [ADR-0022](../../docs/adr/0022-resource-graph-public-api.md).

## Install

```sh
npm install @thomasfosterau/legation effect
```

## Effect version

Peers `effect ^4.0.0`. Tested against `4.1.2` (the version CI pins) and `4.0.0` (the floor; CI runs the tests against it on every PR). Install one copy of `effect` in your app: two copies break `Context` identity.

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
} from "@thomasfosterau/legation";

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

// Reads are plain literals, declared `as const satisfies Query.Read`: checked
// where they are declared, and literal enough to type their rows.
const projectsWithTodos = {
  collection: "projects",
  include: { todos: true },
} as const satisfies Query.Read;
const openTodos = { collection: "todos", where: { done: false } } as const satisfies Query.Read;

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
  const { client } = yield* Client.make({
    nodes,
    mutations,
    clientGroupId: "group-1",
    transport: yield* Transport.makeInMemory(server.handler, "group-1"),
    syncLoop: { pushDebounce: "50 millis" },
  });

  // 4. Reads: `subscribe` pins a read's windows (edges included) so the
  //    replica syncs them; `observe` subscribes for the stream's lifetime.
  //    A read is answered from the replica only once the windows its rows
  //    link to have been pulled: a pull that started after they were
  //    subscribed has applied.
  yield* client.subscribe(projectsWithTodos);
  yield* Effect.forkScoped(
    client.observe(openTodos).pipe(Stream.runForEach((rows) => Effect.log(`${rows.length} open`)))
  );

  // 5. Writes: applied optimistically now, confirmed by the server later.
  yield* client.mutate("project/set", { id: "p1", name: "Launch" });
  yield* client.mutate("todo/set", { id: "t1", projectId: "p1", title: "Ship it", done: false });

  // Typed by the graph: `value` is a project row, `related.todos` its todo rows.
  const [project] = yield* client.query(projectsWithTodos);
  return project?.related.todos.map((todo) => todo.title);
});

Effect.runPromise(Effect.scoped(program)).then((rows) => console.log(JSON.stringify(rows)));
```

### Typed reads

A read's rows are typed from the node graph the Client was built over (`Client.make({ nodes })`, `Client.connect`, `Client.fromView`). Declare each read `as const satisfies Query.Read`, or write it inline: `satisfies` checks its shape where it is declared, and `as const` keeps the literal `collection`, `include` keys and `order` tokens the types are read from. No type arguments, no builder.

```ts
export const productDetail = (id: string) =>
  ({
    collection: "products",
    where: { id },
    include: { seller: true, variants: true },
  }) as const satisfies Query.Read;

const [row] = yield * client.query(productDetail("p1"));
row?.value.name; //            the products row: attributes, `id`, `one`-edge keys
row?.related.seller; //        a `one` edge: the sellers row, or `null` when it is absent
row?.related.variants; //      a `many` / `paginated` edge: the variants rows
row?.related.reviews; //       compile error: this read does not include `reviews`
```

`client.query`, `client.observe`, `client.answer`, `client.observeAnswers` and the framework hooks check the read against the graph where it is used (`Query.Validate`): a collection the graph does not have, an `include` key that is not an edge of the node, or a `where` key or `order` token that is not a field of its row fails to compile, the error naming the key. Renaming an attribute or an edge therefore breaks every read and every row access that used the old name.

| Type                       | What it is                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client.ResolvedRow<R, G>` | A row of read `R` over graph `G` (default: the registered graph): `{ id, value: Node.RowOf<N>, related }`, `related` holding exactly the included edges. `Client.ResolvedRow` alone is the untyped row. |
| `Client.Answer<R, G>`      | What `client.answer` resolves to and `client.observeAnswers` emits: `{ rows, completeness }`, `rows` typed as `Client.ResolvedRow<R, G>` types them.                                                    |
| `Client.Client<G>`         | A Client over graph `G` (`typeof nodes`). `Client.Client` alone accepts any read and resolves untyped rows; a typed Client is assignable to it.                                                         |
| `Node.NodeRegistry<N>`     | What `Node.registry([...])` returns: the graph, carrying the union of its node types `N`.                                                                                                               |
| `Node.RowOf<N>`            | A node's row type (branded ids: `Id<"products">` is `string & Brand<"products/id">`, so it assigns to `string`).                                                                                        |
| `Query.Validate<G, R>`     | The checks a read must pass against a graph; a function that forwards a checked read takes `read: R & Query.Validate<G, R>` and passes `R` on explicitly (`client.query<R>(read)`).                     |
| `Register`                 | The app's graph, registered once for the hooks that find the Client in context (below).                                                                                                                 |

A read the graph cannot describe statically is not checked, and its rows are untyped (`value: unknown`, `related` keyed by `string`), never a compile error: one whose `collection` is a `string` (built at runtime, or annotated `const read: Query.Read = …`, which widens it), the dynamic parts of a literal read (a `where` built as a `Record`, a full `Predicate`, `order` tokens typed `string`), and any read over a Client typed `Client.Client`.

**Hooks need the graph registered.** A framework hook (`useQuery` in `@thomasfosterau/legation-svelte`) finds the Client in context, so it learns the graph's types from one declaration, next to the graph:

```ts
export const nodes = Node.registry([products, sellers, variants]);

declare module "@thomasfosterau/legation" {
  interface Register {
    readonly nodes: typeof nodes;
  }
}
```

Register the graph the app's Client is built over: the hooks trust that the rows the context Client emits are that graph's. Without a registration the hooks accept any read and resolve it to untyped rows.

In a real deployment the server runs on its own (a Worker, or a process of its own) and the client connects with `transport: { url }`. See [`@thomasfosterau/legation-alchemy-cloudflare`](../alchemy-cloudflare) for the Cloudflare Workers topology, [SQL backend](#sql-backend-thomasfosteraulegationsql) below for a database-backed `Backend`, and [`@thomasfosterau/legation-browser`](../browser) for the browser hosts. The fuller examples are [`examples/todo`](../../examples/todo), one node with optimistic writes and offline use, and [`examples/commerce`](../../examples/commerce), the full deployment.

### Identity: who sent a request

Auth filters and mutators see the request's identity on `SyncContext.identity`. You supply it with an `IdentityResolver` on `Server.make({ auth: { identity } })`: the server calls `resolve` once per push, pull and read with an `IdentityRequest`, which is the client group the request names and the `RequestCredentials` of the transport request it arrived on. The resolver verifies a credential (a signed session cookie, an API key) and returns the principal. Lookup by header name is case-insensitive, and an absent header is `Option.none()`:

```ts
import { Effect, Option } from "effect";
import { Authorization, Server } from "@thomasfosterau/legation";

const identity: Authorization.IdentityResolver = {
  resolve: ({ credentials }) =>
    Option.match(credentials.header("authorization"), {
      // Fail closed to anonymous: return the anonymous identity, don't fail.
      onNone: () => Effect.succeed(undefined),
      onSome: (header) => verifyApiKey(header), // your own check: Effect<User | undefined>
    }),
};

const server = yield * Server.make({ backend, auth: { policy, identity } });
```

- **Only the resolver sees the credentials.** `SyncContext`, middleware, auth filters, logs, spans and errors get the client group and the identity `resolve` returned, never a header. `RequestCredentials` offers no way to list its headers, and prints as `RequestCredentials(<redacted>)`. Don't put a credential's value in the identity you return or in an `AuthorizationError`'s message: a failing `resolve` fails the request, and the message reaches the client.
- **The client group is client-chosen.** Never treat `clientGroupId` alone as proof of who is asking. Resolve from a verified credential, or from a binding your own sign-in wrote (as `examples/commerce` does).
- **Carriers present the credentials.** `RpcTransport.layerHandlers` (on `./internal`) passes each RPC call's headers: the HTTP request's over `RpcServer.layerProtocolHttp`, the upgrade request's over `layerProtocolWebsocket`. Headers the RPC client attaches to a call (`RpcClient.withHeaders`) are merged in and win on a clash, so never trust a header an upstream proxy sets to vouch for a user. The Cloudflare room passes the room request's headers, and the SvelteKit helpers take `credentials: requestCredentials(event)`. A carrier you write passes `{ credentials: Option.some(Authorization.credentialsFromHeaders(request.headers)) }` as the second argument of `handler.handlePush`, `handlePull` and `handleRead`. `credentialsFromHeaders` accepts a WHATWG `Headers`, any iterable of `[name, value]` pairs, or a plain record. A handler outside the sync protocol builds its request's `SyncContext` the same way, with `Authorization.resolveContext(Option.some(resolver), { clientGroupId, credentials })` (legation-jsonapi's `RestHandlers` does).
- **No request means no credentials.** `Transport.makeInMemory` (the loopback) and a handler call without options present `Authorization.noCredentials`. `Hydration.snapshot({ credentials })`, `Server.mutate({ credentials })` and `Transport.makeInMemory(handler, group, { credentials })` act for a real request in the same process. The loopback's `credentials` may also be an `Effect<Option<RequestCredentials>>`, read on every call, for a client whose session changes (a cookie jar a sign-in writes).

### Partial answers offline

`client.query` answers an uncovered read from the server; when no server can answer (offline, or a transport without `read`), it answers from the replica instead, which can hold fewer rows than the server would return. To know which happened, ask with `client.answer(read)` instead: it resolves to the same rows with their completeness beside them. `client.observeAnswers(read)` is `observe` with the same addition. Both are checked and typed as `query` is, so `answer.rows` holds the read's typed rows:

```ts
const answer = yield * client.answer({ collection: "todos" });
answer.rows; // what client.query resolves to
answer.completeness; // "partial" offline and uncovered; "complete" otherwise
```

- `"complete"`: a pulled subscription covers the read, or the server answered it. Rows are only called complete when they were read after the pull that covers them.
- `"partial"`: the read is uncovered and the replica answered it. An `observeAnswers` stream is partial until its windows are pulled, then emits the rows again as complete.

The answer is a plain value, `Client.Answer<R, G>` (`{ rows, completeness }`, with `Client.Completeness` = `"complete" | "partial"`), so filtering or copying the rows never loses it. `query` and `observe` resolve to the rows alone.

## API

Everything below is on the root entry, `@thomasfosterau/legation`.

| Export          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node`          | A resource type. `Node.make(type, { attributes, edges, filterable, sortable })` defines one; `Node.registry([...])` closes and validates a graph.                                                                                                                                                                                                                                                                                                                                                                                      |
| `Edge`          | A relationship between nodes: `Edge.one` (a foreign key on this node), `Edge.many` (the dependent collection, named by its `inverse`) and `Edge.paginated` (a cursor-windowed collection with a fixed `order`).                                                                                                                                                                                                                                                                                                                        |
| `Collection`    | The named set of one node type that a client materializes. `Node.registry` derives it from the graph.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Query`         | The read. A `Query.Read` is a plain literal `{ collection, where, include, order, first, after }`, declared `as const satisfies Query.Read` (or `Query.make({...})`, which keeps it literal too) so its rows are typed ([Typed reads](#typed-reads)); `Query.named(name, args)` declares a server-resolved named query.                                                                                                                                                                                                                |
| `Aggregate`     | Read projections over a query: `Aggregate.count`, `Aggregate.sum(field)`, `min`, `max` and `avg`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Mutation`      | The write. `Mutation.make(name, schema)` declares a named intent; `Mutation.registry` pairs each with its optimistic `local` handler. (`Mutator` is a deprecated alias.)                                                                                                                                                                                                                                                                                                                                                               |
| `Client`        | The one-per-thread object. `Client.make` owns an engine and returns `{ client, engine, store }`, so engine-level tools such as devtools attach to what it built; `Client.connect` joins one hosted elsewhere, such as a service worker. It offers `query`, `observe`, `answer`, `observeAnswers` (the rows with their completeness), `subscribe`, `mutate`, `mutateWithAck`, `mutationStates`, `reset` and `totalOf` (a subscription's total as the last pull reported it, #210).                                                      |
| `ClientStore`   | Durable replica and journal storage. `makeMemory` is the default; `makeKeyValue` and `layerKeyValue` wrap any key-value store. The browser package supplies IndexedDB.                                                                                                                                                                                                                                                                                                                                                                 |
| `Transport`     | The carrier seam: the `ClientTransport` and `ServerHandler` services, plus `makeInMemory` (loopback; `setOnline(false)` fails its calls until it is back), `simulateOffline` and `withFallback`.                                                                                                                                                                                                                                                                                                                                       |
| `Identity`      | The identity boundary. A durable replica belongs to one resolved identity; `Client.make({ identity })` and `client.reset(fingerprint)` enforce it.                                                                                                                                                                                                                                                                                                                                                                                     |
| `Hydration`     | Serialisable snapshots of a client's durable state (`dehydrate`, `hydrate`, `snapshot`), for server rendering and hydration.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Server`        | One per backend. `Server.make({ backend, auth })` gives the protocol `handler` to mount on a carrier, `broadcast` announces out-of-band changes, and `mutate` runs a named Mutation as one of a client group's mutations (a form action's entry point, ADR-0030) and answers its receipt.                                                                                                                                                                                                                                              |
| `Backend`       | The storage contract you implement: apply mutations transactionally, evaluate a subset, and list permanent rejections (`rejections`, which a pull reports so a lost push response still settles the mutation as rejected, #365). An optional `evaluateCounted` also reports each subset's total, the rows its filter matches whatever its window, which each pull then carries (`PullResponse.totals`, #210); the memory, SQL and JSON:API backends provide it at no extra cost. The `Backend` service is what `Server.make` consumes. |
| `MemoryBackend` | The reference in-memory backend, for tests and prototypes: `make`, `layer`, `handler` and `validatedHandlers`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Authorization` | Deny-by-default read filters: `policy` builds them per collection (`allowAll` opts a collection in), a filter's `NamedSet`s are resolved per session (`namedSet` reads one's members off a backend collection), `IdentityResolver` resolves a request's identity from its client group and `RequestCredentials` (`credentialsFromHeaders`, `noCredentials`), and `SyncMiddleware` hooks the request path.                                                                                                                              |
| `FilterPolicy`  | The filterable and sortable declarations a node makes, which `Authorization` enforces on client-supplied `where` and `order`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Predicate`     | The filter algebra (`eq`, `isIn`, `and`, `or`, `not`, `exists` and others). It is the full form of `Query`'s `where` and the form auth filters take.                                                                                                                                                                                                                                                                                                                                                                                   |
| Errors          | Typed errors, including `StoreError`, `TransportError`, `QueryError`, `MutationRejected` and `AuthorizationError`.                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Adapter authors: `@thomasfosterau/legation/internal`

The engine seams live on a second entry point, `@thomasfosterau/legation/internal`: `ClientEngine`, `ClientView`, `Subset`, `Mirror`, `EngineHost`, `MirrorChannel`, `MirrorProtocol`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo` and the protocol and transport codecs. The sibling packages (`@thomasfosterau/legation-browser`, `@thomasfosterau/legation-jsonapi`, `@thomasfosterau/legation-alchemy-cloudflare`) compose from it. It is not the app-facing API, and it moves faster than the root entry.

#### Host requests and introspection over a mirror

A `Mirror` asks its engine host for anything outside the `ClientView` surface through one generic envelope (`HostRequest`, ADR-0021 amendment). A **request kind** is declared once, with its schemas, and both sides encode and decode through it:

```ts
import { EngineHost, HostRequest, Introspection, Mirror } from "@thomasfosterau/legation/internal";
import * as Schema from "effect/Schema";

// Declared once, shared by host and mirror. Outside core, prefix the name with your package.
const echo = HostRequest.single("my-package/echo", {
  request: Schema.Struct({ text: Schema.String }),
  response: Schema.String,
});

// Host: `store` serves the introspection kinds; `requests` serves your own.
yield *
  EngineHost.run({
    channel,
    engine,
    store,
    requests: [HostRequest.handler(echo, ({ text }) => Effect.succeed(text))],
  });

// Mirror: typed answers, or a `HostRequestError`.
const mirror = yield * Mirror.make({ channel, mutators, requestTimeout: "5 seconds" });
const text = yield * mirror.request(echo, { text: "hi" });
const intro = Introspection.fromMirror(mirror); // an `EngineIntrospection<HostRequestError>`
const journal = yield * intro.journal;
```

- `HostRequest.single(name, { request, response })` / `HostRequest.streaming(...)` declare a kind; `HostRequest.handler(kind, (input) => Effect)` / `HostRequest.streamHandler(kind, (input) => Stream)` serve one. A later handler for a name replaces an earlier one. `HostRequest.NoInput` and `HostRequest.Done` are the empty request and response.
- `mirror.request(kind, input)` waits for one value; `mirror.stream(kind, input)` follows a streaming kind's answer until the host ends it. Stopping or interrupting the stream sends `HostRequestCancel`, and the host interrupts its handler; the mirror's `Disconnect` (or the host's liveness sweep) cancels everything it holds.
- Failures are a `HostRequestError` with `kind`, `message` and `reason`: `UnknownKind` (the host does not serve it), `InvalidRequest` (the payload does not fit the request schema), `Failed` (the handler failed or died), or `Unanswered`. A request is `Unanswered` when no answer arrives within `requestTimeout` (default 10 seconds; what a host that predates the envelope looks like), and every request in flight is `Unanswered` when the host restarts. A stream has no reply timeout, since it may rightly stay quiet, and is not replayed after a restart: re-request it.
- **Introspection.** Given its `store`, the host serves `Introspection.requests`: single-reply `introspect/subscriptions`, `introspect/journal`, `introspect/cookie`, `introspect/collections` and `introspect/syncFailures`, and streaming `introspect/events`, each typed by the `EngineIntrospection` member it serves. `Introspection.fromMirror(mirror)` builds the same view `Introspection.make(engine, store)` does. Mutation states stay on `mirror.mutationStates`. `EngineIntrospection.syncFailures` is the engine's recent terminal sync failures (`ClientEngine.recentSyncFailures`, the last 50, oldest first).
- **Hydration into a hosted store** (#146). Given its `store`, the host also serves `Hydration.requests.hydrate` (on the root entry): a tab holding a server-rendered `Hydration.Snapshot` asks `mirror.request(Hydration.requests.hydrate, snapshot)`, and the host answers `{ hydrated: true }` or `{ hydrated: false, reason }`. The host owns the empty-store gate (`Hydration.hydrateUnpulled(engine, store, snapshot)`): with the engine's pulls held (`ClientEngine.withPullsHeld`), it hydrates iff the store is empty (`Hydration.isEmpty`: no cookie, no rows, no journalled or unpulled mutations) and no pull has started since the engine was built. Otherwise the reason is `NotEmpty` or `AlreadyPulling`, the store is untouched, and nothing needs doing: the host's replica is at least as fresh as the snapshot. The first snapshot to reach an empty host wins. After a hydration the engine re-syncs its views and its first pull continues from the snapshot's cookie. A cold host's first pull usually beats the tab's snapshot across the mirror, so `EngineHost.run({ hydrationWindow })` holds the pulls of a host started over an empty, unpulled store until the first `hydrate` request or the window's end (`Hydration.makeGate`); a store that is not empty is never held. `@thomasfosterau/legation-svelte`'s `createClient({ channel, snapshot })` is the tab half.

```ts
import { ClientEngine, Subset } from "@thomasfosterau/legation/internal";

// Adapter code is typed against the seams, not the app-facing surface.
export type Engine = ClientEngine.ClientEngine;
export type Plan = Subset.Subset;
```

## SQL backend: `@thomasfosterau/legation/sql`

A driver-agnostic SQL reference backend, on its own entry point so an app
without a database never loads it. It needs only `effect`; the driver is yours.

- **`Sql`** — a pure translator from a `Subset` predicate to a parameterized
  `WHERE` clause (and a full `SELECT`), with SQLite (`?`) and PostgreSQL (`$n`)
  dialects.
- **`SqlBackend`** — an implementation of the core `Backend` contract over a
  tiny `SqlExecutor` seam (`query` / `run` / `transaction`, and the optional
  `transactional` flag, which an executor without transactions sets to
  `false`). Bring your own
  driver (`better-sqlite3`, `effect/sql`, `pg`, …); the backend supplies
  subset evaluation, row fetching, and the transactional, idempotent,
  gap-checked mutation-id ledger.
- **`PgExecutor`** — the `SqlExecutor` for PostgreSQL, over the `SqlClient`
  service from `effect/sql` (the driver, such as `@effect/sql-pg`, is yours to
  provide). See [PostgreSQL](#postgresql) below.
- **`PollingHintSource`** — a tier-2 change-data-capture hint source over the
  same `SqlExecutor` seam: it polls each table on an interval for a cheap
  change-detector (`COUNT(*)` plus `MAX(versionColumn)`) and pokes subscribers
  when a collection changes out of band (cron, admin tools, `psql`). See the
  [change-data-capture guide](../../docs/change-data-capture.md).

Reads push the predicate to the database via `WHERE` and finalise
order/limit/cursor locally with `Subset.apply`. The `WHERE` is exact on both
dialects (ADR-0028): every node compiles to the three-valued expression
`Predicate.evaluate` computes. A table mapping's `kinds` declare which columns
are text, instants, numbers or booleans: a column declared `text` gets an
explicit code-point collation (`COLLATE "C"` / `COLLATE BINARY`) on every
comparison, literals bind by the declared kind, and booleans are stored as
`0`/`1` on SQLite and decoded back by the backend. Writes run app-authored
handlers inside one transaction, and each mutation's `lastMutationId` is
claimed before its handler runs. Mutations from different client groups are
serialisable: SQLite serialises its writers, and PostgreSQL runs each
transaction at `SERIALIZABLE` (a handler whose reads went stale is refused
with a serialization failure, which the client retries). An executor without
transactions sets `transactional: false` and bumps after the handler instead
(D1), and D1 does not isolate handlers, so it does not meet that guarantee.
A permanent rejection is remembered in the client's ledger row, and a replayed
copy reports it. A copy that a concurrent call committed first is dropped
differently by dialect: on SQLite it lists its rejection directly, and on
PostgreSQL it is refused with a transient `BackendError`, and its retry lists it.

> **PostgreSQL apps must pass `dialect: Sql.postgres` to `SqlBackend.make`.**
> That dialect is what sets `SERIALIZABLE` on each mutation transaction. Leave it
> out and the backend falls back to SQLite's dialect, which runs no isolation
> statement and raises no error for that. Batches then run at PostgreSQL's default
> READ COMMITTED, and a lost update across client groups goes unreported.
> A hand-written dialect without a `serializable` statement also gets no
> isolation statement, so its executor must provide the isolation itself. The
> executor's `transaction` must also open a top-level transaction, not a savepoint
> nested in another: PostgreSQL refuses `SET TRANSACTION` there, and the batch
> fails with a `BackendError` instead of running weaker.

### PostgreSQL

`PgExecutor.make(sql)` turns a PostgreSQL `SqlClient` into the executor
`SqlBackend` runs over. It needs only `effect`, so the package gains no
dependency; install a driver that provides `SqlClient`, such as
`@effect/sql-pg`, and pass `dialect: Sql.postgres`:

```ts
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";
import { PgExecutor, Sql, SqlBackend } from "@thomasfosterau/legation/sql";

const makeBackend = Effect.gen(function* () {
  const sql = yield* SqlClient; // provided by PgClient.layer({ url }) from @effect/sql-pg
  return SqlBackend.make({
    executor: PgExecutor.make(sql),
    dialect: Sql.postgres,
    tables,
    mutators,
    handlers,
  });
});
```

What the executor guarantees:

- **Each push is one transaction.** `transaction` is the client's
  `withTransaction`: one `BEGIN … COMMIT` on one connection, so a batch's
  mutation-id claims commit together with its handlers' writes, and a failure
  rolls back both. `Sql.postgres` runs the transaction at `SERIALIZABLE`; a
  handler whose reads went stale is refused (SQLSTATE 40001) with a
  `BackendError`, and the client retries. Don't run the backend inside an outer
  `withTransaction`: that makes the batch a savepoint, where PostgreSQL refuses
  `SET TRANSACTION`, and the push fails.
- **Statements run unprepared.** Nothing depends on a named prepared statement
  surviving from one query to the next, which a transaction-mode pooler does
  not promise.
- **Round trips.** A push costs one transaction, however many mutations it
  holds. `evaluate` costs one statement per subset, plus one per `exists` node
  in its predicate. A pull goes through `evaluateCounted`, which asks for all
  of its subsets in one `UNION ALL` statement (the one `evaluateMany` uses),
  plus one per `exists` node, however many subsets it holds
  ([#505](https://github.com/thomasfosterau/legation/issues/505)). The same
  statement gives each subset's total, since the backend reads every matching
  row and cuts the window itself
  ([#210](https://github.com/thomasfosterau/legation/issues/210)).
- **Rows as JSON in a pull.** Each arm of `evaluateMany`'s statement carries
  its row as JSON (`row_to_json`), since mappings' columns differ, and the
  backend orders, windows and versions the rows it reads back from that JSON.
  **Keep integer, double and text values in typed columns (`integer`,
  `double precision`, `text`), not in JSON or wide numeric types:** those are
  the types JSON carries exactly as the driver reads them, so a pull over them
  gives the same answer as `evaluate` in one statement.
  - A number JSON cannot carry exactly (an integer past ±(2^53 − 1), such as
    a wide `bigint` id or version; a `numeric` with more digits than a double
    holds; such a number inside a `json` / `jsonb` column) sends the pull to
    one `evaluate` per subset, so it reads each value as the driver does, and
    the backend logs a warning, once per collection and column for the
    backend's life, whose cause is a `SqlBackend.InexactJsonNumber` naming the
    collection and the column (never the value). A scalar `bigint` or
    `numeric` column then arrives exactly, as the driver's text. A number
    nested in a `json` / `jsonb` column does not: the driver parses that
    column with `JSON.parse` too, so `evaluate` rounds it the same way, and
    the fallback only keeps the pull equal to `evaluate`. Keep such values in
    typed columns, or as JSON strings, if they must be read exactly. Declare
    a scalar column with a typed column in the read relation (a view can cast
    it) to keep the pull one statement.
  - Other types the driver does not read as JSON does (`bigint` and `numeric`
    within a double's range, which the driver reads as text; `timestamptz`,
    which it reads as a `Date`) reach the backend as JSON gives them, so a
    `versionColumn` or ordered column of those types gives the pull versions
    or an order of a different type than `evaluate` and `getRows`. Cast them
    to the typed columns above in the read relation.
  - SQLite has no such caveat: its `UNION ALL` columns take any type per row,
    so each arm carries the relation's own columns by position.
- **Errors.** A failed statement or transaction fails as a `BackendError` with
  the statement's text, never its parameters, in the message, and the driver's
  `SqlError` as its `cause`.

#### Behind a pooler (Hyperdrive)

The atomicity above holds only if every statement from `BEGIN` to `COMMIT`
reaches the same server connection. A pooler that runs a transaction on one
connection keeps it; one that can split a transaction across connections breaks
Backend guarantee 1, as D1 does (see `D1Executor`). In a Worker, build the
`PgClient` layer per request, inside the request's scope, from the binding's
connection string: a Worker cannot reuse one request's connection in another.
What Hyperdrive guarantees about transactions, isolation statements and query
caching is still to be confirmed against its documentation:
[#506](https://github.com/thomasfosterau/legation/issues/506).

### Ledger without the `rejections` column

**Action required before upgrading.** `SqlBackend` remembers each permanent
rejection in the client's ledger row, in a `rejections` column, so a replayed
copy of a rejected mutation reports the committed rejection and its reason. A
ledger created without that column fails each push with a `BackendError` that
names this migration, and that push writes nothing. Whatever version created your
ledger table (`sync_mutations`, or the `mutationsTable` you configured), check
whether it has the column, and add it only if it does not:

```sql
-- PostgreSQL: returns a row only when the column is already there
SELECT 1 FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'sync_mutations' AND column_name = 'rejections';

-- SQLite: returns a row only when the column is already there
SELECT 1 FROM pragma_table_info('sync_mutations') WHERE name = 'rejections';
```

If the check returns no row, add the column:

```sql
ALTER TABLE sync_mutations ADD COLUMN rejections TEXT;
```

On PostgreSQL, `ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS rejections TEXT;`
does the check and the change in one statement, and is safe to repeat. SQLite has
no `IF NOT EXISTS` for columns, so run the check first: the plain `ALTER TABLE`
fails with "duplicate column" on a ledger that already has the column.

The column is nullable and has no default, so existing rows are unchanged. It is
a metadata-only change on both databases, with a brief lock on the ledger table.

A new install creates the ledger with the column:

```sql
CREATE TABLE sync_mutations (
  client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
  rejections TEXT,
  PRIMARY KEY (client_group_id, client_id)
);
```

The `rejections` value is a JSON object that maps each remembered mutation id to
its reason. A push forgets the rejections below its lowest id per client, and a
client that never pushes again keeps its last push's rejections. A pull reports
the rejections its watermark covers, so a client whose push response was lost
settles those mutations as rejected (#365).

## License

MIT
