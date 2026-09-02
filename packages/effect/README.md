# @legation/effect

The Effect-native sync engine. One package, one dependency (`effect`), four layers:

1. **Primitives** — sync keys, cache stores, the write-through cache engine, queries, pagination, mutations, the offline outbox, the sync protocol, transports, and conflict resolution
2. **Client** — a TanStack-Query-style query/mutation/subscription manager and an offline-capable sync client
3. **Cache engine** — write-through HTTP and data caching for service workers and edge runtimes, with pluggable persistence
4. **Server** — a write-through sync hub that fans out updates to subscribed clients

Protocol adapters live in separate packages (e.g. [`@legation/jsonapi`](../jsonapi)).

Coming from TanStack Query / SwiftData / SWR? [Coming from TanStack Query](../../docs/comparisons/coming-from-tanstack-query.md) maps those libraries' concepts onto this engine.

## Status

Targets Effect v4 beta and ESM-only consumers.

## Installation

```bash
bun add @legation/effect effect@4.0.0-beta.107
```

## Module map

| Layer      | Module                              | Purpose                                                                                                  |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Primitives | `SyncKey`                           | Hierarchical keys (`["users", "1"]`) with structural hashing, prefix matching, and key filters           |
| Primitives | `Errors`                            | Tagged errors (`StoreError`, `TransportError`, `ConflictError`, …) usable with `Effect.catchTag`         |
| Primitives | `CacheStore` / `MemoryCacheStore`   | The pluggable storage backend service + in-memory implementation                                         |
| Primitives | `SyncCache`                         | The cache engine: read-through, write-through, dedupe, stale-while-revalidate, invalidation, events      |
| Primitives | `Query` / `Pagination` / `Mutation` | Declarative descriptors for reads, paginated reads, and writes with optimistic updates                   |
| Primitives | `Outbox`                            | A durable queue of pending mutations for offline-first clients                                           |
| Primitives | `Protocol` / `Transport`            | The serializable client/server wire protocol and the connection abstraction (+ in-memory pair for tests) |
| Primitives | `Versioned`                         | Versioned values and conflict resolution strategies                                                      |
| Primitives | `PromiseFacade`                     | Drive anything here from non-Effect code with promises and callbacks                                     |
| Client     | `QueryClient`                       | Fetch/observe/refetch/prefetch/invalidate, paginated queries, mutations                                  |
| Client     | `MutationState`                     | Observable mutation lifecycle (idle → pending → success/failure)                                         |
| Client     | `Subscriptions`                     | Wire a `ClientTransport`'s server messages into the local cache                                          |
| Client     | `SyncClient`                        | The offline sync engine: query client + outbox + transport                                               |
| Client     | `ClientFacade`                      | Promise/callback client for non-Effect apps                                                              |
| Cache      | `WriteThroughCache`                 | Cache-engine vocabulary over `SyncCache`: `get`/`put`/`getPaginated`/`invalidate`/`purge`                |
| Cache      | `HttpCache`                         | HTTP request/response caching for service-worker `fetch` handlers and edge runtimes                      |
| Cache      | `KeyValueStoreAdapter`              | `CacheStore` backed by Effect's `KeyValueStore` (localStorage, file system, Redis, SQL)                  |
| Server     | `ServerStore`                       | The authoritative, versioned backing store interface + in-memory implementation                          |
| Server     | `Sessions`                          | Registry of connected clients and their subscriptions                                                    |
| Server     | `SyncHub`                           | The server engine: write-through mutations, conflict detection, fan-out                                  |
| Server     | `ServerFacade`                      | Promise/callback server for non-Effect backends                                                          |

## Primitives: read-through and write-through caching

```ts
import { Duration, Effect, Layer } from "effect";
import { MemoryCacheStore, SyncCache } from "@legation/effect";

const cacheLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const program = Effect.gen(function* () {
  const cache = yield* SyncCache.SyncCache;

  // Loads on miss, serves from cache while fresh, deduplicates concurrent loads.
  const user = yield* cache.read({
    key: ["users", "1"],
    loader: fetchUserFromApi("1"),
    staleTime: Duration.minutes(5),
    tags: ["users"],
  });

  // Write-through with optimistic update and automatic rollback on failure.
  const updated = yield* cache.write({
    key: ["users", "1"],
    writer: pushUserToApi(user),
    optimistic: user,
  });

  return updated;
});

await Effect.runPromise(program.pipe(Effect.provide(cacheLayer)));
```

## Client: queries, mutations, and offline sync

```ts
import { Effect, Layer, Stream } from "effect";
import { MemoryCacheStore, Query, QueryClient } from "@legation/effect";

// QueryClient.layer composes SyncCache.layer internally; it only needs a CacheStore.
const layer = QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const program = Effect.gen(function* () {
  const client = yield* QueryClient.QueryClient;

  const userQuery = Query.make({
    key: ["users", "1"],
    loader: Effect.succeed({ id: "1", name: "Ada" }),
    staleTime: "5 minutes",
  });

  // Read-through fetch.
  const user = yield* client.fetch(userQuery);

  // Observe the query: loading -> success -> (live updates on cache changes).
  const states = yield* Stream.runCollect(Stream.take(client.observe(userQuery), 2));

  return { user, states };
});
```

`SyncClient` combines the query client, an `Outbox`, and a `ClientTransport` into an offline-capable engine:

```ts
import { SyncClient } from "@legation/effect";

const engine = Effect.gen(function* () {
  const client = yield* SyncClient.SyncClient;
  // Apply a mutation locally and enqueue it for delivery to the server.
  yield* client.mutateLocal(createTodo, { title: "Buy milk" });
  // Run the background engine (streams server updates + pushes the outbox on reconnect).
  yield* Effect.forkScoped(client.runSync);
});
```

Non-Effect apps use the promise facade:

```ts
import { ClientFacade } from "@legation/effect";

const client = ClientFacade.makeClient({ maxEntries: 1000 });
const user = await client.fetch(["users", "1"], () => fetch("/api/users/1").then((r) => r.json()), {
  staleTimeMillis: 60_000,
});
const unsubscribe = client.subscribe(
  ["users", "1"],
  () => fetch("/api/users/1").then((r) => r.json()),
  { onData: (user) => render(user) }
);
await client.dispose();
```

## Cache engine: service workers and edge runtimes

`WriteThroughCache` exposes two freshness windows: **`swr`** (serve cached, refresh in background once elapsed) and **`ttl`** (evict entirely once elapsed).

```ts
import { Duration, Effect, Layer } from "effect";
import { HttpCache, MemoryCacheStore, PromiseFacade, WriteThroughCache } from "@legation/effect";

const facade = PromiseFacade.make(
  WriteThroughCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()))
);
const cachePromise = facade.run(Effect.service(WriteThroughCache.WriteThroughCache));

self.addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(
    cachePromise.then((cache) =>
      HttpCache.handleFetchPromise(facade, cache, {
        request: event.request,
        upstream: (request) => Effect.promise(() => fetch(request)),
        swr: Duration.seconds(30),
        ttl: Duration.minutes(10),
      })
    )
  );
});
```

`handleFetch` semantics: GET requests are served read-through (only 2xx responses are persisted); POST/PUT/DELETE pass through to upstream and invalidate cached entries for the same URL on success.

Persistence: provide `KeyValueStoreAdapter.layer` instead of `MemoryCacheStore.layer()` to persist the cache to any Effect `KeyValueStore` (browser storage, file system, Redis, SQL).

Known limitation: `HttpCache` stores response bodies as text; binary bodies are not supported yet.

## Server: write-through sync hub with fan-out

```text
                         ┌──────────────────────────────┐
 client A ──push────────▶│            SyncHub           │──set──▶ ServerStore
                         │  (write-through + fan-out)   │        (source of truth)
 client B ◀───Updated────│                              │◀── publish() / remove()
 client C ◀───Updated────│   SessionRegistry (who's in) │    invalidate()
                         └──────────────────────────────┘   (server-initiated writes)
```

```ts
import { Effect, Layer } from "effect";
import { ServerStore, Sessions, SyncHub, Transport } from "@legation/effect";

const ServerLayer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

// For each new connection (WebSocket, SSE, in-memory pair, ...):
const handle = (connection: Transport.ServerConnection) =>
  Effect.gen(function* () {
    const hub = yield* SyncHub.SyncHub;
    // Runs until the connection closes; cleans up the session on exit.
    yield* hub.handleConnection(connection);
  });
```

Write-through semantics: each pushed mutation is conflict-checked against the store's current version (clients send the `baseVersion` they last saw), applied with `store.set` (which bumps the version), acknowledged to the pusher, and fanned out as `Updated` to every _other_ subscribed session. Fan-out is concurrent and best-effort — a dead client cannot block delivery to others.

Server-initiated writes use the same path: `hub.publish(key, value)`, `hub.remove(key)`, `hub.invalidate(filter)`.

## Mutations, pagination, outbox

```ts
import { Mutation, Outbox, Pagination } from "@legation/effect";
import { Option } from "effect";

// Mutations with optimistic patches and invalidation
const updateTodo = Mutation.make({
  key: ["todos", "update"],
  execute: (todo: Todo) => api.updateTodo(todo),
  optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
  invalidates: [["todos", "list"]],
});
yield * Mutation.execute(cache, updateTodo, { id: "1", title: "Ship it", done: true });

// Paginated queries cached as accumulated pages under one key
const todosPage = {
  key: ["todos", "list"],
  loadPage: (cursor: Option.Option<number>) =>
    api.listTodos({ offset: Option.getOrElse(cursor, () => 0) }),
};
const first = yield * Pagination.readFirstPage(cache, todosPage);
const more = yield * Pagination.fetchNextPage(cache, todosPage);

// Offline outbox
const outbox = yield * Outbox.Outbox;
yield * outbox.enqueue(["todos", "create"], { title: "Buy milk" });
yield * outbox.drain((entry) => pushToServer(entry), { maxAttempts: 5 });
```

## Related packages

- [`@legation/jsonapi`](../jsonapi) — JSON:API protocol adapter

## License

MIT
