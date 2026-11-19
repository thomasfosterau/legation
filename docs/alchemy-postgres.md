# PostgreSQL inside a room

How long a PostgreSQL client lives when `Room.make`'s `backend` is a
`SqlBackend` over `PgExecutor`, what is safe to hold across requests, and
what Hyperdrive guarantees about the backend's transactions and reads.

## What the code does

- **The backend is built once per in-memory instance.** `Room.make` runs
  `backend` in the object's per-instance phase, which Alchemy's Durable Object
  bridge runs under `blockConcurrencyWhile` when the instance is constructed
  (`DurableObjectBridge.ts`), and the sync server keeps that `Backend` for
  every request until the instance goes. So a client built in `backend`
  outlives the request, by design: the server, its CVR conversations and its
  poke hub are long-lived, and so is the backend they hold.
- **An eviction rebuilds it.** The first request after an eviction constructs
  a new instance and runs `backend` again. (A room does not hibernate: its
  lease heartbeat keeps it resident until it is evicted.)
- **Its scope is the instance's, and is never closed.** `backend` runs with the
  room instance's `Scope`, so `Layer.build(PgClient.layer(...))` there holds
  the pool for the instance's life. Nothing closes that scope: on eviction the
  platform drops the instance and its sockets, no finalizer runs, and the
  server sees the connections disconnect rather than close.
- **The class's layers are per isolate.** Alchemy builds the layers provided
  to a Durable Object class (or its Worker) once per isolate and shares them
  with every instance in it (the bridge memoizes the build). A `PgClient`
  provided that way is shared by every room in the isolate, and workerd ties a
  socket to the object that opened it. Build the client in `backend`, never as
  a layer on the class.

## What is safe

With a **direct connection** (a connection string to PostgreSQL or to a pooler
such as PgBouncer, not Hyperdrive), build the pool in `backend`:

```ts
backend: Effect.gen(function* () {
  // `url` is a `Redacted` connection string; `PgClient` is `@effect/sql-pg`'s.
  const context = yield* Layer.build(
    PgClient.layer({ url, maxConnections: 1, idleTimeout: "30 seconds" })
  );
  return SqlBackend.make({
    executor: PgExecutor.make(Context.get(context, SqlClient)),
    dialect: Sql.postgres,
    tables,
    mutators,
    handlers,
  });
}).pipe(Effect.orDie),
```

- **Keep the pool small.** Every awake room holds its own pool, so the server
  sees up to (awake rooms) × `maxConnections`. One or two per room, behind a
  pooler, is the usual shape.
- **Set an idle timeout.** An open outbound connection is pending I/O, which
  keeps a Durable Object from being evicted for up to 15 minutes per
  operation (Cloudflare's "Durable Object lifecycle"). A room is resident
  anyway (its lease heartbeat stops it hibernating), but an idle pool would
  hold database connections for every resident room and keep the server
  holding sockets that will never close cleanly. The idle timeout releases
  them.
- **A dropped connection is not an error to handle.** A statement on a dead
  connection fails as a `BackendError`, the client retries its push or pull,
  and the pool reconnects.

### Name the database user

`@effect/sql-pg`'s `PgClient` resolves its connection settings when it is
built, not at its first query. If it finds no user, building the client
fails with `SqlError: … No username configured`. It looks in three places:
the `username` option, the user part of `url`
(`postgres://user:pass@host/db`), and the process's `USER` / `USERNAME`
environment variables. Checked in 4.1.4; in 4.1.2, with the `pg` driver, a
missing user surfaced only on connect.

A Worker has no `USER`, so a connection string there must carry the user, or
the layer must set `username`. Hyperdrive's `connectionString` already
includes one, so the per-request pattern below needs nothing more.

## Hyperdrive: build per request

`@alchemy.run/cloudflare` documents Hyperdrive's `host` and `password` as
"valid only within the current Worker invocation" (`Hyperdrive.ConnectClient`).
A pool built once per room from them opens its later connections with an
earlier invocation's credentials. **Do not hold a Hyperdrive client across
requests**: Hyperdrive is a pool itself, and Cloudflare's model is a client per
invocation ("Connection lifecycle": create the client inside the handler; the
Worker-to-Hyperdrive connection is cleaned up when the invocation ends, a
Durable Object's hibernation or eviction included). Cloudflare also warns that
a client held open in a long-lived Durable Object keeps an origin connection
allocated from the pool, which many rooms can exhaust.

`Backend.perRequest` gives a room exactly that. Its argument builds the
backend for one request, in that request's `Scope`; the room's sync server
runs it once per push, pull and read (`Backend.forRequest`) and closes the
scope when the request ends, which closes the client. Everything else the room
holds (its CVRs, its fan-out bus, its named-set cache) stays per instance.

```ts
// At init, beside the room's other bindings:
const hyperdrive = yield * Cloudflare.Hyperdrive.Connect(AppDatabase);

return (
  yield *
  Room.make({
    nodes,
    // Built once per instance; the client inside is built once per request.
    backend: Backend.perRequest(
      Effect.gen(function* () {
        // Read in the request, so the credentials are this invocation's.
        const url = yield* hyperdrive.connectionString;
        const context = yield* Layer.build(PgClient.layer({ url, maxConnections: 1 }));
        return SqlBackend.make({
          executor: PgExecutor.make(Context.get(context, SqlClient)),
          dialect: Sql.postgres,
          tables,
          mutators,
          handlers,
        });
      }).pipe(
        Effect.mapError(
          (cause) => new BackendError({ message: "Hyperdrive connect failed", cause })
        )
      )
    ),
    policy,
    shards: LegationShard,
  })
);
```

- **One push is one acquisition.** The push's `applyMutations` is one
  `PgExecutor.transaction`, a top-level `withTransaction` on the client this
  request built, so its mutation-id claims and the handlers' writes commit or
  roll back together on one connection (Backend guarantee 1). With
  `maxConnections: 1` every statement of the request, the pull's reads
  included, uses that one connection.
- **Concurrent requests get separate clients.** Two requests in flight on one
  room each run `acquire`, so neither sees the other's connection.
- **The captured services.** `hyperdrive.connectionString` needs Alchemy's
  `RuntimeContext`; `Backend.perRequest` captures it where `backend` runs and
  provides it to each acquisition.
- **A named set over the backend** (`Authorization.namedSet(backend, …)`)
  opens its own acquisition when it resolves, apart from the pull's.

## What Hyperdrive guarantees

From Cloudflare's Hyperdrive documentation ("Connection pooling", "Query
caching", "Limits"), checked in November 2026:

- **A transaction stays on one origin connection.** Hyperdrive pools in
  transaction mode: a client's transaction runs on a single origin connection
  from `BEGIN` to `COMMIT` or `ROLLBACK`, and the connection returns to the
  pool afterwards. So `PgExecutor.transaction` (one top-level
  `withTransaction`) keeps a push's mutation-id claims and its handlers'
  writes atomic through Hyperdrive, and Backend guarantee 1 holds. Hyperdrive
  is not a D1-style `transactional: false` topology.
- **`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` is honoured.** A `SET`
  inside an explicit transaction takes effect for that transaction; the
  connection is `RESET` when it returns to the pool. `Sql.postgres` issues it
  as the transaction's first statement, so every push transaction is
  serializable. Outside a transaction a `SET` lasts one query, so nothing the
  backend relies on persists between statements.
- **Query caching can serve the sync server stale reads. Turn it off.**
  Caching is on by default (a 60 second `max_age`). Hyperdrive caches
  read-only queries that run outside a transaction and does not invalidate a
  cached result when the database is written. `evaluate`, `evaluateMany` and
  `getRows` run outside a transaction, so a cached answer would give a CVR an
  old view, and the pull would ship rows the client already has or miss a
  write it should see. Bind the room to a Hyperdrive configuration created
  with `--caching-disabled` (or `wrangler hyperdrive update <id>
  --caching-disabled`). An app that wants caching for its own reads binds a
  second, cached configuration beside it, and counts both configurations'
  origin connections against the database's limit.
- **Unprepared statements are fine.** `PgExecutor` runs every statement
  unprepared, so nothing depends on a named prepared statement surviving
  between queries, which transaction pooling would not guarantee.
- **Limits.** A statement runs for at most 60 seconds, then Hyperdrive
  terminates it. Keep the push transaction short: it holds an origin
  connection until it commits, and a configuration has a bounded number of
  origin connections (about 20 on the free plan, configurable on paid plans).
