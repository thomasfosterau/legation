# Domain Context

The effect-sync monorepo implements a data synchronization engine built on Effect. This glossary defines the project's vocabulary; use these terms (not synonyms) in code, issues, and docs.

## Glossary

| Term                       | Meaning                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync key**               | A hierarchical, serializable key (`["users", "1"]`) identifying one piece of synchronized data. The universal addressing scheme across cache, client, server, and wire protocol. |
| **Key filter**             | A selector over sync keys: exact, prefix, or predicate. Prefix filters power hierarchical invalidation and subscriptions.                                                        |
| **Cache store**            | A pluggable storage backend (`CacheStore`) holding cache entries. Implementations: memory, KeyValueStore-backed (browser storage, Redis, SQL), …                                 |
| **Cache entry**            | A cached value plus metadata: `updatedAt`, `staleAt`, `expiresAt`, `version`, `tags`.                                                                                            |
| **Freshness**              | A cache entry is _fresh_ (serve it), _stale_ (serve-then-revalidate or reload), or _expired_ (must reload). Computed from entry timestamps, never stored.                        |
| **Read-through**           | Cache access that consults the store first and runs the _loader_ only on miss/staleness, writing the result back.                                                                |
| **Write-through**          | A write that goes to the upstream source of truth first, then updates the cache with the canonical result.                                                                       |
| **Loader**                 | The effect that fetches a value from its source of truth on a cache miss.                                                                                                        |
| **Writer**                 | The effect that pushes a value to the source of truth in a write-through.                                                                                                        |
| **Stale-while-revalidate** | Serving a stale cached value immediately while refreshing it in the background.                                                                                                  |
| **Invalidation**           | Marking entries stale (not deleting them) so the next read re-fetches. By key filter or by tag.                                                                                  |
| **Tag**                    | A label attached to cache entries for group invalidation (e.g. `"users"`).                                                                                                       |
| **Query**                  | A declarative description of a read: key + loader + freshness windows + retry policy + tags.                                                                                     |
| **Query state**            | The observable lifecycle of a query: `initial` / `loading` / `success` / `failure`, plus `isFetching` / `isStale`.                                                               |
| **Mutation**               | A declarative description of a write: key + execute effect + optimistic patches + invalidations.                                                                                 |
| **Optimistic update**      | A cache patch applied while a mutation is in flight, rolled back if the mutation fails.                                                                                          |
| **Outbox**                 | A durable queue of pending mutations awaiting delivery to the server (offline-first support).                                                                                    |
| **Sync protocol**          | The serializable message vocabulary between clients and servers: Subscribe/Push/Pull/Ping → Updated/Removed/Invalidated/acks.                                                    |
| **Transport**              | The connection abstraction carrying protocol messages. `ClientTransport` (client side), `ServerConnection` (server side).                                                        |
| **Fan-out**                | The server pushing an `Updated`/`Removed`/`Invalidated` notification to every subscribed client after a write.                                                                   |
| **Sync hub**               | The server-side engine: session registry + write-through to the server store + fan-out.                                                                                          |
| **Server store**           | The server's source of truth, with per-key monotonic versions.                                                                                                                   |
| **Version**                | A per-key monotonic counter (server) or opaque token used for conflict detection.                                                                                                |
| **Conflict**               | A push whose `baseVersion` no longer matches the server's current version for that key.                                                                                          |
| **Conflict strategy**      | How conflicts resolve: `preferLocal`, `preferRemote`, `lastWriteWins`, `fail`, or a custom merge function.                                                                       |
| **Promise facade**         | The promise/callback wrapper that lets non-Effect code drive the engine.                                                                                                         |

## Packages and their bounded contexts

Package boundaries follow dependency footprint (ADR-0006): everything needing only `effect` is in core.

| Package                               | Context                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@thomasfosterau/effect-sync-core`    | The whole engine: keys, cache engine, queries, mutations, outbox, protocol, transports, the client manager (queries/mutations/subscriptions/offline sync), the service-worker/edge cache, and the server-side sync hub with fan-out. |
| `@thomasfosterau/effect-sync-jsonapi` | JSON:API v1.1 protocol adapter (formerly `@thomasfosterau/effect-chancery`).                                                                                                                                                         |

## Avoided terms

- ~~"Query cache"~~ → say **cache store** (storage) or **sync cache** (engine)
- ~~"Refetch"~~ in core APIs → say **force refresh** (`forceRefresh`); "refetch" is acceptable in client-package UX docs
- ~~"Garbage collection / gcTime"~~ → say **time to live / expiry**
- ~~"Document"~~ (except in JSON:API adapter where it's the spec's term)
