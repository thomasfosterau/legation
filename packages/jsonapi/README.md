# @thomasfosterau/effect-sync-jsonapi

A [JSON:API v1.1](https://jsonapi.org/format/) protocol adapter for the
`@thomasfosterau/effect-sync-core` sync engine, built on
[Effect](https://effect.website).

It gives you three things:

- **JSON:API types** — `ResourceObject`, `JsonApiDocument`, `Relationship`,
  `JsonApiError`, request options, and friends.
- **Standalone helpers** — `fetchResource`, `fetchResources`,
  `createResource`, `updateResource`, `deleteResource`, plus
  remote↔local sync helpers, all returning Effects.
- **A sync-engine adapter** (`Adapter`) — query and mutation descriptor
  builders that plug JSON:API resources into the protocol-agnostic core so
  reads are cached, deduplicated, and invalidated like any other entry.

> This package was formerly published as `@thomasfosterau/effect-chancery`.

## Install

```sh
npm install @thomasfosterau/effect-sync-jsonapi @thomasfosterau/effect-sync-core effect
```

`effect` and `@thomasfosterau/effect-sync-core` are required alongside this
package.

## Quick start

### Standalone helpers

Every helper is an `Effect` requiring an `HttpClient` and a `SyncConfig`.

```ts
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { fetchResource, SyncConfig } from "@thomasfosterau/effect-sync-jsonapi";

const program = fetchResource("articles", "1", { include: ["author"] }).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, { baseUrl: "https://api.example.com" })
);

const article = await Effect.runPromise(program);
```

### Adapter with the sync engine

The `Adapter` builders return core `Query` / `Pagination` / `Mutation`
descriptors. Run them against a `SyncCache` to get read-through caching,
request deduplication, optimistic updates, and tag/prefix invalidation.

```ts
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { MemoryCacheStore, Mutation, Query, SyncCache } from "@thomasfosterau/effect-sync-core";
import { Adapter, SyncConfig } from "@thomasfosterau/effect-sync-jsonapi";

const articleQuery = Adapter.resourceQuery("articles", "1");
const createArticle = Adapter.createResourceMutation("articles");

const cacheLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const program = Effect.gen(function* () {
  const cache = yield* SyncCache.SyncCache;

  // Read-through: the first read hits the API, later reads hit the cache.
  const article = yield* cache.read(Query.toReadOptions(articleQuery));

  // A create mutation invalidates the `articles` collection so list
  // queries refetch on their next read.
  yield* Mutation.execute(cache, createArticle, {
    type: "articles",
    attributes: { title: "Hello" },
  });

  return article;
}).pipe(
  Effect.provide(cacheLayer),
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, { baseUrl: "https://api.example.com" })
);
```

#### Keys and tags

The adapter uses hierarchical sync keys rooted at `"jsonapi"`:

| Builder                  | Key                        |
| ------------------------ | -------------------------- |
| `resourceKey(t)`         | `["jsonapi", t]`           |
| `resourceKey(t, id)`     | `["jsonapi", t, id]`       |
| `resourceKey(t, id, o)`  | `["jsonapi", t, id, o]`    |
| `resourcesQuery(t)`      | `["jsonapi", t, "list"]`   |
| `resourcePageQuery(t)`   | `["jsonapi", t, "page"]`   |
| `createResourceMutation` | `["jsonapi", t, "create"]` |
| `updateResourceMutation` | `["jsonapi", t, "update"]` |
| `deleteResourceMutation` | `["jsonapi", t, "delete"]` |

Every query is tagged `jsonapi:${type}`, and create/update/delete mutations
invalidate that tag (and the `["jsonapi", type]` key prefix), so a write to
one resource refreshes the relevant collection and single-resource reads.

#### Pagination

`resourcePageQuery` uses the page number as its cursor. When
`options.page.size` is supplied, a page is treated as having a successor when
its item count equals the page size; without a size, any non-empty page is
assumed to have a successor. Drive it with the core `Pagination` helpers
(`readFirstPage`, `fetchNextPage`).

## Conflict strategies

`updateResource` (and `syncResourceToRemote`) treat an HTTP `409` as a
`ConflictError`. `SyncConfig.conflictStrategy` controls how
`syncResourceToRemote` resolves it:

- `"error"` (default) — fail with the `ConflictError`.
- `"remote"` — fetch the remote version, store it locally, and return it.
- `"local"` — keep the local version (store and return it without retrying
  the remote write).

```ts
import { syncResourceToRemote, SyncConfig, Storage } from "@thomasfosterau/effect-sync-jsonapi";

const program = syncResourceToRemote(localArticle).pipe(
  Effect.provideService(SyncConfig, {
    baseUrl: "https://api.example.com",
    conflictStrategy: "remote",
  })
  // ...provide HttpClient and a Storage implementation
);
```

## Errors

All errors are Effect `Data.TaggedError` types, so they can be matched with
`Effect.catchTag` / `Effect.catchTags` and carry structured fields. They
extend `Error`, so `.message` is also available.

```ts
import { ApiError, ParseError, ConflictError } from "@thomasfosterau/effect-sync-jsonapi";

new ParseError({ message: "Failed to parse JSON", cause });
new ApiError({ message: "API returned errors", errors });
new ConflictError({ message: "Resource version conflict", localVersion: "1", remoteVersion: "2" });

program.pipe(
  Effect.catchTag("ApiError", (error) => Effect.logError(error.errors)),
  Effect.catchTag("ConflictError", (error) => Effect.logError(error.message))
);
```

## License

MIT
