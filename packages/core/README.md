# @thomasfosterau/effect-sync-core

Protocol-agnostic sync and cache primitives built on [Effect](https://effect.website). This is the foundation of the effect-sync packages: everything else (the client query manager, the write-through cache engine, the server fan-out hub, the JSON:API adapter) composes these primitives.

## Status

Targets Effect v4 beta and ESM-only consumers.

## What's inside

| Module             | Purpose                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncKey`          | Hierarchical keys (`["users", "1"]`) with structural hashing, prefix matching, and key filters — the addressing scheme for everything           |
| `Errors`           | Tagged errors (`StoreError`, `TransportError`, `ConflictError`, …) usable with `Effect.catchTag`                                                |
| `CacheStore`       | The pluggable storage backend service: entries with staleness/expiry/version/tags metadata                                                      |
| `MemoryCacheStore` | In-memory `CacheStore` with optional LRW eviction                                                                                               |
| `SyncCache`        | The cache engine: read-through, write-through, request deduplication, stale-while-revalidate, prefix/tag invalidation, and a cache event stream |
| `Query`            | Query descriptors (key + loader + freshness + retry) and observable query state                                                                 |
| `Pagination`       | Cursor/offset paginated queries cached as accumulated pages under one key                                                                       |
| `Mutation`         | Mutation descriptors with optimistic cache patches, rollback, and invalidation                                                                  |
| `Outbox`           | A durable queue of pending mutations for offline-first clients                                                                                  |
| `Protocol`         | The serializable client/server wire protocol (subscribe, push, pull, fan-out notifications)                                                     |
| `Transport`        | Connection abstraction (`ClientTransport` / `ServerConnection`) plus an in-memory pair for tests                                                |
| `Versioned`        | Versioned values and conflict resolution strategies                                                                                             |
| `PromiseFacade`    | Drive any of the above from non-Effect code with promises and callbacks                                                                         |

## Installation

```bash
bun add @thomasfosterau/effect-sync-core effect@4.0.0-beta.65
```

## Quick start: read-through caching

```ts
import { Duration, Effect, Layer } from "effect";
import { MemoryCacheStore, SyncCache } from "@thomasfosterau/effect-sync-core";

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

  return user;
});

await Effect.runPromise(program.pipe(Effect.provide(cacheLayer)));
```

## Write-through with optimistic updates

```ts
const updated =
  yield *
  cache.write({
    key: ["users", "1"],
    writer: pushUserToApi(user), // the upstream write; its result becomes the cached value
    optimistic: user, // shown immediately; rolled back if the writer fails
  });
```

## Mutations

```ts
import { Mutation } from "@thomasfosterau/effect-sync-core";

const updateTodo = Mutation.make({
  key: ["todos", "update"],
  execute: (todo: Todo) => api.updateTodo(todo),
  optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
  invalidates: [["todos", "list"]],
});

yield * Mutation.execute(cache, updateTodo, { id: "1", title: "Ship it", done: true });
```

## Paginated queries

```ts
import { Option } from "effect";
import { Pagination } from "@thomasfosterau/effect-sync-core";

const todosPage = {
  key: ["todos", "list"],
  loadPage: (cursor: Option.Option<number>) =>
    api.listTodos({ offset: Option.getOrElse(cursor, () => 0) }),
};

const first = yield * Pagination.readFirstPage(cache, todosPage);
const more = yield * Pagination.fetchNextPage(cache, todosPage);
Pagination.items(more); // all loaded items, flattened
```

## Offline outbox

```ts
import { Outbox } from "@thomasfosterau/effect-sync-core";

const outbox = yield * Outbox.Outbox;
yield * outbox.enqueue(["todos", "create"], { title: "Buy milk" });

// later, when connectivity returns:
yield * outbox.drain((entry) => pushToServer(entry), { maxAttempts: 5 });
```

## Non-Effect consumers

```ts
import { MemoryCacheStore, PromiseFacade, SyncCache } from "@thomasfosterau/effect-sync-core";
import { Effect, Layer } from "effect";

const facade = PromiseFacade.make(
  SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()))
);

const user = await facade.run(
  Effect.flatMap(Effect.service(SyncCache.SyncCache), (cache) =>
    cache.read({
      key: ["users", "1"],
      loader: Effect.promise(() => fetch("/users/1").then((r) => r.json())),
    })
  )
);

await facade.dispose();
```

## Related packages

- [`@thomasfosterau/effect-sync-client`](../client) — TanStack-Query-style client manager built on this package
- [`@thomasfosterau/effect-sync-cache`](../cache) — write-through cache engine for service workers and edge runtimes
- [`@thomasfosterau/effect-sync-server`](../server) — server-side sync engine with client fan-out
- [`@thomasfosterau/effect-sync-jsonapi`](../jsonapi) — JSON:API protocol adapter

## License

MIT
