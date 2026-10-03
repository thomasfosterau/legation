# legation vs Convex

[Convex](https://www.convex.dev) is a reactive backend platform: a hosted
(also self-hostable) database with serverless TypeScript functions, where
client-visible **queries are subscriptions** — the server re-runs a query
when data it read changes and pushes fresh results over a WebSocket. legation
is a client-side sync engine over a backend **you already own** (ADR-0009).
The two solve overlapping problems from opposite ends: Convex moves your
backend into its model so reactivity can be computed server-side; legation
moves a subset of your data into the client so reads and writes work without
the server on the hot path.

Vocabulary note: terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Where state lives

|                     | Convex                                                | legation                                                                                                                                                                |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth     | Convex's database (documents in tables)               | Your **backend** (any store satisfying the backend contract; `@thomasfosterau/legation-sql` ships the SQL reference)                                                    |
| Client state        | In-memory cache of subscribed query results           | A durable local replica: subscribed **collection** subsets in IndexedDB, plus the **journal** of pending writes                                                         |
| Reactivity computed | Server-side (query re-execution on dependency change) | Client-side (**live queries** re-run over the local replica when **patches** or the **optimistic overlay** change)                                                      |
| Server infra        | Convex deployment (hosted or self-hosted binary)      | A library inside your existing server process — `SyncServer.make` mounted on your router (the [commerce example](../../examples/commerce) mounts it next to a JSON:API) |

The deepest difference is the first row. Convex's model is only coherent
because Convex owns the database: queries are deterministic functions run
transactionally against it, so the platform can know precisely which queries
a write invalidates and push exact updates. That is a genuinely strong
consistency story — every client sees a transactionally-consistent snapshot,
and subscriptions never deliver torn reads.

legation deliberately does not own your database. The **backend contract**
asks your store for two things: run **mutators** transactionally (mutation-id
bump atomic with effects) and evaluate **subscriptions** to (row id, row
version) sets. Everything else — patch computation via **CVR** diffing,
fan-out, rebase — is library code (ADR-0008, ADR-0009). You keep your
schema, your migrations, your ORM, your ops. The cost is that consistency
between collections is whatever your backend's transactions give you; the
patch protocol guarantees each client converges, not that every client
observes every intermediate state.

## Writes and conflicts

Convex mutations are serverless functions with optimistic concurrency
control: reads are tracked, conflicting transactions retry server-side.
Client-side optimistic updates exist but are ephemeral — a hand-written
overlay applied while the mutation is in flight, discarded when the
authoritative result arrives. There is no durable queue: a mutation issued
while offline fails.

legation writes are **mutators** — named, schema-validated intents defined
once and executed twice (optimistically against the local replica,
authoritatively on your backend). They are journaled durably, survive
reloads, and replay on every **rebase**: conflict resolution _is_ replay,
with per-mutation **mutation ids** giving the backend exactly-once in-order
application, and **permanent rejections** acknowledged-and-skipped so a bad
mutation can't poison the queue. The optimistic effect is dropped exactly
when that mutation's authoritative effect is observed — not merely when the
request resolves, which is the subtle bug class hand-rolled overlays
(Convex's included) leave to the application author.

## Offline

This is the clearest fork in the road:

- **Convex**: online-first. The cache serves stale reads briefly, but there
  is no persistent replica and no write queue. A tab that loses its
  connection is read-only-stale until it returns.
- **legation**: offline-first by construction. The replica is durable
  (IndexedDB), the journal is durable, and in the recommended deployment the
  whole engine runs in a **service worker** (ADR-0010) — tabs hold only a
  **mirror** and keep working; writes queue and push when connectivity
  returns (`BrowserConnectivity` gates the sync loop). The
  commerce example goes further: the app is server-rendered from a
  plain REST API and the engine is _progressive enhancement_ on top, so
  even the no-JS path works.

If your product must work in a tunnel, Convex is the wrong shape. If your
product is a collaborative dashboard on office Wi-Fi, Convex's server-side
reactivity is simpler than running a replica you don't need.

## Reads

Convex queries are arbitrary TypeScript run server-side — join, aggregate,
call helpers, read anything the function's auth allows. That expressiveness
is the payoff of server-side execution.

legation subscriptions are deliberately narrower: a **subscription** is a
(collection, **predicate**, order, limit/cursor) subset, where predicates are
serializable expression trees the server AND-s with mandatory **auth
filters** (deny by default, ADR-0015). Richer reads compose client-side over
the replica: `Related` joins declared relationships, `Aggregate` folds rows,
and **named queries** (`Query.make`) give you server-resolved parameterized
subsets when the resolution logic must stay server-side. In the
service-worker deployment even joins run in the worker — tabs receive
resolved rows over the mirror protocol (ADR-0021).

The trade: Convex re-executes on the server (unbounded expressiveness, costs
server work per subscriber per change); legation re-evaluates incrementally
on the client (bounded expressiveness, zero server work for a read that
doesn't change what's synced).

## Auth

Convex authenticates users (JWT/OpenID) and you write authorization checks
inside each function. legation binds a client group to an identity via
`IdentityResolver` (the example keeps a `client_groups` table aligned with a
[Better Auth](https://better-auth.com) session) and enforces **auth
filters** per collection server-side; client predicates can only narrow what
the filter allows. Both are deny-by-default when used as documented; the
difference is imperative checks in functions vs declarative row filters.

## Operational surface

Convex is a platform: you get its dashboard, log streams, scheduled
functions, file storage, vector search — and its pricing, limits, and
availability story. Self-hosting the open-source backend is possible but is
still "run Convex", not "add a library".

legation is three processes you already run: your app server (the sync
server mounts on it), your database, your CDN. Scale-out is ADR-0011's
territory (serialized **invalidation bus** over Redis Streams or a WebSocket
broker; CVR in a shared KeyValueStore); out-of-band writers publish **hints**
through a **hint source** (ADR-0019) instead of being invisible to sync.

## When to choose which

Choose **Convex** when you're starting a product without an existing
backend, want transactionally-consistent reactive queries with minimal
architecture, are comfortable with a platform dependency, and don't need
offline writes.

Choose **legation** when the backend already exists (or must be yours),
when offline-first or main-thread-light architecture is a requirement, when
you want reads served locally at memory speed, or when you're already in the
Effect ecosystem — the engine is Effect-native end to end (schemas, layers,
streams), which is either its biggest draw or its biggest adoption filter
depending on your team.

They can coexist: nothing stops a Convex-backed app from being one of
legation's backends — the contract only asks for transactional mutator
execution and subset evaluation — though you would be paying for two
reactivity systems and should probably pick one.
