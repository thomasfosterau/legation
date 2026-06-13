# Domain Context

The effect-sync monorepo implements a data synchronization engine built on Effect. This glossary defines the project's vocabulary; use these terms (not synonyms) in code, issues, and docs.

The engine follows the mutation-log/rebase sync model (ADR-0008): named write intents flow up, server-computed state patches flow down, and the client rebases pending intents on top of authoritative state.

## Glossary

### Data model

| Term            | Meaning                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collection**  | A named, schema-typed set of rows, keyed by row id. The unit the client materializes locally and queries.                                           |
| **Row**         | One value in a collection, identified by (collection, row id), carrying a row version assigned by the backend.                                      |
| **Row version** | An opaque per-row token the backend changes on every authoritative write. The basis for computing what a client is missing.                         |
| **Schema**      | The Effect Schema describing a collection's row type; the single source of truth for validation, serialization (wire + persistence), and inference. |

### Writes

| Term                   | Meaning                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mutator**            | A named, schema-validated write intent (name + args) defined once and executed twice: optimistically on the client, authoritatively on the backend. The backend implementation may differ (validation, permissions, side effects).            |
| **Mutation**           | One invocation of a mutator: its name, args, and per-client sequence number.                                                                                                                                                                  |
| **Mutation id**        | A per-client sequential number on each mutation, giving the backend exactly-once, in-order application and giving the client precise acknowledgement.                                                                                         |
| **Journal**            | The client's durable, causally-ordered log of pending mutations awaiting backend acknowledgement. Survives reloads and crashes.                                                                                                               |
| **Pending mutation**   | A journal entry not yet acknowledged by the backend. Its local effects live in the optimistic overlay and are replayed on every rebase.                                                                                                       |
| **Optimistic overlay** | The local effects of pending mutations, rendered above confirmed rows. Dropped per-mutation exactly when that mutation's authoritative effect is observed — never merely when the request resolves.                                           |
| **Rebase**             | On incoming authoritative state: discard optimistic effects, apply the patch, replay pending mutations on top, and reveal the result atomically. Conflict resolution _is_ replay: mutators may compute different effects against newer state. |

### Sync protocol

| Term                         | Meaning                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Subscription**             | A client-registered collection subset — (collection, predicate, order, limit/cursor) — that the backend keeps synced to the client.                                                  |
| **Predicate**                | A serializable expression tree over row fields, used in subscriptions. Client predicates can only narrow what auth filters allow.                                                    |
| **Client view record (CVR)** | The server-side record of exactly which row versions a client holds, per subscription. The basis for computing minimal patches.                                                      |
| **Cookie**                   | The opaque token a client presents on pull, identifying the CVR snapshot it has.                                                                                                     |
| **Patch**                    | An ordered sequence of row put/delete operations moving a client's view from one cookie to the next.                                                                                 |
| **Push**                     | The client delivering pending mutations to the backend.                                                                                                                              |
| **Pull**                     | The client requesting a patch: cookie + subscriptions in, patch + new cookie + mutation acknowledgements out. The canonical correctness path — sync must be correct over pull alone. |
| **Poke**                     | A contentless "pull soon" hint. Realtime delivery is a latency optimization, never a correctness dependency.                                                                         |
| **Sync transport**           | The carrier moving protocol messages between client and server. Messages are schema-defined; carriers are pluggable (the RPC implementation is the default).                         |

### Reads

| Term            | Meaning                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Live query**  | A declarative query (data, not an opaque function) over local collections whose results re-emit when rows it depends on change.                                                            |
| **Mirror**      | A tab's in-memory copy of its subscribed rows, hydrated from the shared store and kept current by engine broadcasts. Live queries and the optimistic overlay run synchronously against it. |
| **Engine host** | Where the sync engine runs. In browsers the recommended host is a service worker (the per-origin singleton); the engine itself is host-agnostic.                                           |

### Server

| Term                 | Meaning                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**          | The app-owned storage and mutator-execution environment fulfilling the server contract: run mutators transactionally (mutation-id bump atomic with effects) and evaluate subscriptions to (row id, row version) sets. |
| **Auth filter**      | A mandatory server-side predicate per collection, AND-ed into every subscription before evaluation. Deny by default.                                                                                                  |
| **Sync middleware**  | A server-side interception point over subscription and push handling, for cross-cutting concerns (tenancy, cost control, telemetry).                                                                                  |
| **Session**          | One connected client as seen by the server: its identity, subscriptions, and transport connection.                                                                                                                    |
| **Invalidation bus** | The pluggable channel carrying committed-write hints from the backend to sync sessions, possibly across instances. Fan-out is poke-then-pull over this bus.                                                           |
| **Sync room**        | A packaged composition of sessions + CVR storage + invalidation bus that runs identically in-process or as a Durable Object.                                                                                          |
| **Fan-out**          | Recomputing and delivering patches to every session whose subscriptions a committed write may affect.                                                                                                                 |

### HTTP cache (service-worker module)

| Term                       | Meaning                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **HTTP cache**             | The separate service-worker module caching fetch-event Request/Response pairs via the browser Cache API.          |
| **Freshness**              | A cached response is _fresh_ (serve it), _stale_ (serve-then-revalidate), or _expired_ (must reload).             |
| **Stale-while-revalidate** | Serving a stale cached response immediately while refreshing it in the background.                                |
| **Tag**                    | A label attached to cached responses for group invalidation, including invalidation driven by collection changes. |

## Packages and their bounded contexts

Package boundaries follow dependency footprint (ADR-0006): everything needing only `effect` is in core. Runtime globals count as dependencies.

| Package                               | Context                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@thomasfosterau/effect-sync-core`    | The engine: collections, mutators, journal, overlay/rebase, live queries (+ reactivity Atom bindings), protocol messages + transport seam (RPC default), CVR bookkeeping (in-memory + shared KeyValueStore), backend contract + in-memory reference, invalidation bus (+ serialized seam with Redis-Streams / WebSocket brokers), sync room, HTTP cache. |
| `@thomasfosterau/effect-sync-browser` | Browser-runtime adapters: service-worker engine host, IndexedDB client store, tab mirror + broadcast transport.                                                                                                                                                                                                                                          |
| `@thomasfosterau/effect-sync-node`    | Node-runtime adapters for serving the protocol.                                                                                                                                                                                                                                                                                                          |
| `@thomasfosterau/effect-sync-jsonapi` | JSON:API v1.1 collection loaders: map documents into engine collection rows (a `type` is a collection, a resource a row). Read-side only — writes are mutators.                                                                                                                                                                                          |

## Avoided terms

- ~~"Outbox"~~ → say **journal**
- ~~"Sync hub"~~ → say **sync room** (the composition) or **backend** (the storage/execution contract)
- ~~"Server store"~~ → say **backend**
- ~~"Conflict strategy"~~ → conflicts resolve by **rebase** (mutator replay); there is no per-key merge-strategy vocabulary
- ~~"Query cache" / "refetch"~~ → live queries don't refetch; they re-run over local collections when patches or the overlay change
- ~~"Garbage collection / gcTime"~~ → say **time to live / expiry**
- ~~"Document"~~ (except in the JSON:API package where it's the spec's term)
