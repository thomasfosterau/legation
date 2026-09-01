# legation vs Replicache + ElectricSQL

These two are best compared together because they are _halves_: [Replicache](https://replicache.dev)
pioneered the client-side mutation-log/rebase model (write path + client
store) over server endpoints you implement; [ElectricSQL](https://electric-sql.com)
syncs Postgres query results to clients over HTTP (read path) and leaves
writes to your API. A common architecture pairs one of each. legation
implements both halves as one engine, and openly descends from the first:
ADR-0008 adopts Replicache's push/pull/poke/rebase/CVR design almost
term-for-term, so this comparison is part genealogy.

Vocabulary note: terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## vs Replicache

Replicache's model _is_ legation's model: named mutators executed
optimistically client-side and authoritatively in your push endpoint;
per-client **mutation ids** for exactly-once in-order application; a pull
endpoint returning a patch + **cookie** computed from a per-client view
record (**CVR**); **rebase** replaying pending mutations over each
authoritative update; **pokes** as contentless hints with pull as the
correctness path. legation keeps all of it, including the vocabulary.

What differs is everything around the model:

- **Server-side ownership.** Replicache gives you a protocol specification
  and says "implement push and pull" — the CVR bookkeeping, patch diffing,
  auth filtering, and fan-out in your endpoints are yours to write
  (the reference "todo-row-versioning" sample is the spec in practice).
  legation ships that server half as a library (ADR-0009): `SyncServer.make`
  does CVR diffing, subscription evaluation, and fan-out against a narrow
  **backend contract** (transactional mutator execution + subset
  evaluation), with `@legation/sql` as the SQL reference implementation and
  a shared contract test suite (`BackendContract`) you run over your own.
- **Subscriptions vs key space.** Replicache syncs a per-client key-value
  space; which keys a client gets is decided inside your pull endpoint.
  legation makes the subset first-class: clients register **subscriptions**
  ((collection, **predicate**, order, limit/cursor)), the server AND-s
  mandatory **auth filters** (deny by default, ADR-0015), and the same
  subset language drives SQL translation and CVR evaluation.
- **Reads.** Replicache offers `subscribe` over a key-scan of the client
  store. legation types collections with Effect Schema and layers **live
  queries**, `Related` joins over declared relationships, aggregates, and
  **named queries** on top (ADR-0021's client view).
- **Engine placement.** Replicache runs per-tab on the main thread
  (with cross-tab dedup via its persistence layer). legation's recommended
  host is a **service worker** running one engine for all tabs; tabs hold
  **mirrors** and receive already-resolved rows (ADR-0010, ADR-0021).
- **Status.** Rocicorp has moved its investment to Zero (see
  [`zero.md`](zero.md)); Replicache is free and maintained but no longer the
  frontier. Choosing Replicache today mostly means choosing its
  productionized model — which is also what legation offers, plus the
  server half.

## vs ElectricSQL

Electric (the post-2024 "Electric Next" incarnation) syncs **shapes** —
the results of a Postgres `WHERE` on a table — to clients over plain HTTP
long-polling, through a stateless `electric` service consuming logical
replication. It is read-path only by design: writes go through your API
however they always did, and Electric's docs describe write patterns
(optimistic state on top of shapes) you assemble yourself, or via TanStack
DB's Electric collections.

Compared point by point:

- **Read model.** Electric shapes ≈ legation subscriptions: both are
  server-filtered partial replicas of a table/collection kept current.
  Electric's transport story is a genuine strength — shape logs over HTTP
  are CDN-cacheable, so one hot shape can fan out through edge caches to
  enormous reader counts. legation's pulls are per-client CVR diffs:
  precision (each client gets exactly its delta, across many subsets, with
  per-client auth filters) at the cost of not being shareable/cacheable.
  High-fan-out identical-for-everyone data favors Electric; many small
  per-user views favor legation.
- **Write model.** Electric has none — that's the deal. legation's write
  half (journaled mutators, exactly-once application, rebase, permanent
  rejections) is exactly what you would otherwise hand-roll or import
  Replicache for.
- **Infrastructure.** Electric requires Postgres + logical replication +
  the Electric service. legation mounts in your server process over any
  backend satisfying the contract; change capture from out-of-band writers
  is opt-in via **hint sources** (ADR-0019) rather than a replication-slot
  requirement — the polling source is deliberately tier 2, with pull-based
  correctness (ADR-0008) making hints a latency optimization, never a
  correctness dependency.

## vs the pair

Replicache + Electric covers both halves with two vendors' seams: two
client stores (Replicache's KV + Electric's shapes) or a hand-built bridge,
two auth models, two consistency stories, and your own glue for the
overlap (e.g. an optimistic write landing in Replicache while Electric
streams the authoritative row). It absolutely works — many production apps
run shapes for reads and a mutation queue for writes.

legation's pitch against the pair is _one_ story: one replica, one
optimistic overlay dropped per-mutation exactly when that mutation's
authoritative effect is observed, one auth filter surface, one journal —
and the whole thing hostable in a service worker so the main thread only
renders. The [commerce example](../../examples/commerce)
demonstrates the shape this enables: a JSON:API-first SSR app (works with
JavaScript disabled) where the engine in the service worker progressively
enhances reads and writes into local-first ones.

## When to choose which

Choose **Replicache** when you want the proven mutation-log/rebase model
and are prepared to implement (and own) the server protocol yourself — or
you already have.

Choose **ElectricSQL** when your problem is read-path replication out of
Postgres at scale — especially high fan-out of shared data through CDNs —
and your writes are happy as ordinary API calls.

Choose **the pair** when both halves matter and you prefer battle-tested
specialized parts over one integrated engine.

Choose **legation** when you want both halves integrated — Replicache's
write model with the server half included, plus subscription-based partial
read sync — inside your own backend, off the main thread, in an Effect
codebase.
