# legation vs Zero (Rocicorp)

[Zero](https://zero.rocicorp.dev) is Rocicorp's successor to Replicache: a
general-purpose sync engine where clients declare **ZQL** queries, a
dedicated `zero-cache` service syncs exactly the rows those queries need out
of Postgres, and both reads and writes are incrementally maintained on the
client. Of every system in this series, Zero is the closest relative —
legation follows the same mutation-log/rebase lineage (ADR-0008
acknowledges the Replicache heritage explicitly), so this comparison is
mostly about where two implementations of one philosophy diverge.

Vocabulary note: terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Shared skeleton

Both systems agree on the fundamentals, so the following sentences describe
either: writes are named mutators executed optimistically on the client and
authoritatively on the server, with the client's pending log replayed on top
of each authoritative update (**rebase** — Zero calls the same mechanism
"rebase" too). The server keeps a per-client record of what the client holds
(**CVR** — same term in both) and computes minimal row-level **patches**.
Realtime delivery is a hint, not a correctness dependency: both remain
correct over pull alone (**poke**-then-pull in legation's vocabulary).
Permanent server-side rejection of a mutation acknowledges-and-skips rather
than poisoning the queue. Reads are live queries over a local replica.

If you have internalized Zero's model, legation will feel familiar down to
the names.

## Where they diverge

### Query model: ZQL vs subsets + composition

Zero's flagship feature is **ZQL**: a relational query language (joins,
`where`, `orderBy`, `limit`, `related(...)`) that runs identically against
the client store and the server, with results maintained _incrementally_ by
an IVM (incremental view maintenance) engine on both sides. "Sync what the
queries need" is derived automatically from active queries.

legation's sync unit is deliberately simpler: a **subscription** is a
(collection, **predicate**, order, limit/cursor) subset — a serializable
expression tree, not a query language (ADR-0008 records why: subsets keep
the **auth filter** AND-ing, CVR evaluation, and the SQL translation in
`@legation/sql` analyzable). Richer reads are client-side composition:
`Related` walks declared relationships (with the narrowed
`foreignField IN (...)` subsets auto-subscribed, so the foreign rows sync
too), `Aggregate` folds, and **named queries** cover parameterized subsets
whose resolution must stay server-side. Write-path incremental maintenance
exists (live queries update from patch deltas), but there is no general IVM
over arbitrary joins — a `Related` re-emission re-resolves the join.

The trade: ZQL gives Zero more expressive synced reads with better
asymptotics on large views; legation's subsets are easier to reason about
under auth, and composition keeps the engine core small.

### Infrastructure: zero-cache vs a library in your process

Zero deploys as `zero-cache`, a stateful service between clients and your
Postgres, consuming a logical replication slot, maintaining CVRs in its own
database, and serving WebSockets. It is excellent leverage — and it is a
service you run, with Postgres as a hard requirement.

legation is a library (ADR-0009): `SyncServer.make` mounts on the router of
the server you already have, the **backend contract** is store-agnostic
(the reference implementations are in-memory and SQL — SQLite and Postgres
via `@legation/sql`; the [svelte-commerce example](../../examples/svelte-commerce)
runs SQLite), CVR storage is pluggable (in-memory or any
`KeyValueStore`), and scale-out is the serialized **invalidation bus**
(Redis Streams / WebSocket broker, ADR-0011) rather than a dedicated tier.
Change data capture is opt-in per source (**hint sources**, ADR-0019 — the
polling source is tier 2) instead of a replication-slot requirement.

### Client architecture: main thread vs service worker

Zero's client runs on the main thread (with persistence into IndexedDB).
legation's recommended browser deployment (ADR-0010) hosts the entire
engine — store, transports, sync loop, joins — in a **service worker**;
tabs hold a **mirror** and receive already-resolved rows over a
BroadcastChannel protocol (ADR-0021). The main thread does UI. The mirror
protocol's semantics (observing auto-registers; host restarts announce
`HostReady` and mirrors replay their registrations) exist precisely so the
worker deployment is not second-class.

### Typing and ecosystem

Zero defines schema in its own builder and generates types; it is
framework-agnostic with first-class React/Solid/Svelte/Vue hooks. legation
is **Effect-native**: collections, mutators, and protocol messages are
Effect Schemas (single source of truth for validation, wire format, and
persistence), the engine is layers and streams, and the bindings
(`@legation/react`, `@legation/svelte`) sit over a reactivity core. If your
team is not using Effect, this is real friction — schema definitions,
error handling, and composition all assume it. If it is, everything
composes with the rest of your stack for free (the example's server mounts
sync, a JSON:API built on `effect-jsonapi`, and Better Auth on one Effect
HTTP router).

### Permissions

Zero's permissions are ZQL expressions compiled into queries; legacy
row-level rules run inside `zero-cache`. legation's **auth filters** are
mandatory per-collection predicates AND-ed server-side into every
subscription (deny by default), with relationship-scoped reads via
denormalized keys (ADR-0015) and identity resolved from a client-group
binding — auth never trusts anything client-supplied except the group id
it authenticates.

## Maturity, honestly

Zero has a team building it full-time, a public roadmap, and production
deployments; its IVM engine is years of focused work. legation is younger
and smaller — its strengths are the BYO-backend contract, the
service-worker architecture, and Effect integration, not breadth of query
language or years in production. If you need ZQL-class synced queries
today and Postgres+zero-cache fits your ops, Zero is the safer bet. If you
need the engine inside your own process and stack, or off the main thread,
legation is built for exactly that.

## When to choose which

Choose **Zero** for relational synced queries (ZQL) with incremental
maintenance, when Postgres + a dedicated sync service fits your
infrastructure, and when you want a framework-agnostic client with a
full-time team behind it.

Choose **legation** when sync must be a library inside your existing
server (any backend satisfying the contract, not just Postgres), when the
engine should live in a service worker and keep tabs thin, when your data
model fits collection subsets + declared relationships, or when your stack
is already Effect.
