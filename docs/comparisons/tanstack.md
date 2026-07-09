# legation vs TanStack Query / TanStack DB

TanStack ships two relevant libraries, and they sit on opposite sides of a
philosophical line. [TanStack Query](https://tanstack.com/query/latest) is
the canonical _request cache_: it manages the lifecycle of async fetches —
staleness, retries, deduplication, background refetch. [TanStack
DB](https://tanstack.com/db/latest) is the newer layer that abandons the
request-cache model for the one legation also implements: typed
**collections**, **live queries** over local data, and transactional
optimistic **mutators**. Comparing legation to each is really comparing the
two models — and then comparing two implementations of the second.

There is a dedicated vocabulary translation for people arriving from the
request-cache world: [`docs/coming-from-tanstack-query.md`](../coming-from-tanstack-query.md).
This document is the architectural comparison. Terms in **bold** are defined
in [`CONTEXT.md`](../../CONTEXT.md).

## vs TanStack Query: cache-of-requests vs replica-of-data

TanStack Query's unit of state is _the response of a fetch_, keyed by query
key. Freshness is temporal (`staleTime`), invalidation is manual or
key-based, and "realtime" means refetching on a signal. It is superb at what
it models — but what it models is requests, so N components with N query
keys hold N copies, a mutation must know which keys to invalidate, and
consistency between two cached responses is nobody's job.

legation's unit of state is _the row_. The client holds one replica of each
subscribed **collection** subset; **live queries** are views over that
replica and re-run when it changes; the server ships row-level **patches**
computed from a **CVR**, so invalidation is not a concept — there is nothing
to invalidate, only state to move forward. Writes are **mutators** journaled
durably and rebased, not POSTs followed by `invalidateQueries`.

The models also fail differently offline: a request cache can serve stale
responses but cannot accept writes; legation's **journal** queues writes
durably and pushes them when connectivity returns.

The request-cache model still wins where data is genuinely
request-shaped: third-party APIs you cannot subscribe to, search results,
one-shot RPC. legation's own example app leans on this boundary — its
server-rendered pages read a plain JSON:API (the naive baseline any HTTP
cache could serve), and the sync engine progressively enhances what
benefits from being live.

## vs TanStack DB: same destination, different vehicle

TanStack DB agrees with legation about the destination. Its README could
describe either library: collections as typed sets of rows, differential/
incremental live queries over them, optimistic mutations with server
reconciliation. The differences are in what each library asks of the rest of
your system.

### Sync is pluggable vs sync is the product

TanStack DB is deliberately backend-agnostic about _how rows arrive_: a
collection is populated by an adapter — an ElectricSQL shape, a TanStack
Query fetch, a WebSocket feed — and the write path posts to your API with
hand-over to the sync layer on completion. The library standardizes the
client store and query layer; the sync protocol is someone else's problem
(and choosing/operating it is your problem).

legation is the opposite commitment: the protocol is the core of the
product. Push/pull/**poke**, **mutation ids** with exactly-once in-order
application, **permanent rejections** that acknowledge-and-skip, CVR-diffed
patches, **rebase** on every authoritative update, subscription **auth
filters** — one engine owns write-path and read-path end to end (ADR-0008),
against a **backend contract** you implement once (ADR-0009). You give up
the mix-and-match flexibility; you gain a single correctness story where
the optimistic overlay is dropped exactly when each mutation's
authoritative effect is observed, not when a POST resolves.

### Query engine — a two-tier read model

Both libraries split the same problem the same way, and it is worth naming
the split because it is the crux of the read layer (ADR-0027). Relational
expressiveness — arbitrary joins, DISTINCT, row-level GROUP BY,
computed/cross-field predicates — runs **client-side over already-synced
data**; only a narrow, analyzable predicate is pushed down to the sync layer.
TanStack DB pushes down to its collection adapters; legation's push-down tier
_is_ the **Query**/**subset** language, which compiles to sync windows
natively.

- **The sync tier is deliberately narrow.** A **subscription** is a
  (collection, **predicate**, order, limit/cursor) subset that stays
  serializable and auth-narrowable: the server AND-s a mandatory **auth
  filter** into every one before evaluating it (ADR-0015), and one foreign key
  powers the join, the sync window, the auth scope, and the fan-out topic
  (ADR-0022). That cap is load-bearing, not a limitation — it is what lets the
  wire language be reasoned about server-side.
- **The derived tier is where the expressiveness lives.** `Derive`'s bare
  combinators — `filter` (arbitrary JS predicate), `map`/`select`, `join`
  (arbitrary key equality, inner/left), `groupBy` returning rows, `distinct`,
  `orderedWindow` — compose over any `observe`d source (an engine, a mirror,
  or another combinator, so queries compose from queries) and are
  incrementally maintained by the same version-free multiset IVM core (`map /
filter / join / reduce / distinct / ordered-window`) that TanStack DB's
  differential-dataflow engine uses. `Related` (declared-edge joins that
  auto-sync the foreign rows) and `Aggregate` (live folds) sit alongside them.

The one rule that makes the split safe: **the derived tier never widens what
syncs.** A client-local combinator sees only the rows already synced; if a
derived view needs more, you widen the **Query**, not the combinator. So the
restraint on the wire language is no longer an expressiveness gap on the
client — it is the boundary between what is auth-checked-and-synced and what
is shaped locally.

### Where the engine runs

TanStack DB runs on the main thread. legation's recommended deployment
(ADR-0010) puts the entire engine — IndexedDB store, transports, sync loop,
even joins — in a **service worker**; tabs hold a **mirror** and receive
resolved rows over a broadcast protocol (ADR-0021). One engine serves every
tab: one WebSocket, one replica, no per-tab sync work, and a main thread
that does nothing but UI.

### Ecosystem shape

TanStack DB inherits the TanStack ecosystem: framework adapters everywhere,
enormous community, incremental adoption from TanStack Query. legation is
Effect-native — Effect Schema types every row, mutator, and protocol
message; the engine is layers and streams; bindings exist for React and
Svelte (the Svelte binding is async-first over `<svelte:boundary>`). If
your team isn't using Effect, TanStack DB is the shallower on-ramp by a
wide margin. If it is, legation's server side mounts into the Effect HTTP
stack you already run.

## When to choose which

Choose **TanStack Query** when your data is request-shaped, you need no
offline writes, and a cache with staleness is the honest model for your
problem.

Choose **TanStack DB** when you want the collections + live-queries model
with maximum flexibility in how data syncs and gradual adoption inside the
broad TanStack ecosystem — both libraries give you an incrementally
maintained client-side query engine, so that is no longer the deciding axis.

Choose **legation** when you want the sync _protocol_ solved — durable
offline writes with exactly-once server application, CVR-diffed partial
sync, deny-by-default subscription auth — as one engine over a backend you
own, especially if you want it running in a service worker, and especially
if you're on Effect.
