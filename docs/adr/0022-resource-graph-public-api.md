# ADR-0022: The resource-graph public API — Node, Collection, Query, Mutation, Client, Server

Date: 2026-07-03
Status: Accepted

## Context

The library grew module-by-module, and it shows at the surface:
`@thomasfosterau/legation-effect` exports **39 public namespaces**. A comprehensive
implementation (the commerce example) must understand concepts at
three altitudes at once — domain (`Collection`, `Mutator`, `Subset`,
`Predicate`, named `Query`), machinery (`ClientEngine`, `ClientView`,
`Mirror`, `EngineHost`, `MirrorProtocol`, `MirrorChannel`, `Transport`,
`ClientStore`), and server assembly (`SyncServer`, `Backend`, `Cvr`,
`InvalidationBus`, `BusBrokers`, `HintSource`, `SyncRoom`) — plus ten
reactivity/introspection namespaces that are internals in all but export
status. Review of the example app surfaced the resulting pain concretely:

- The app defines its domain **twice** — once as effect-jsonapi `Resource`s
  for the wire API, once as engine `Collection`s for the replica — with the
  two kept in sync by hand.
- The service-worker deployment forces six concepts on the reader
  (`ServiceWorkerHost`, `ClientView`, `Mirror`, `EngineHost`,
  `MirrorChannel`, `MirrorProtocol`) to express one idea: _the engine runs
  in the worker; the UI talks to it as if it were local._ "Mirror" names
  the mechanism, not the intent, and it is not intuitive.
- Server-side, broadcasting a change is not one obvious verb but an
  assembly (`InvalidationBus` + brokers + hint sources + CVR wiring),
  even though the underlying semantics — publish a hint, poke subscribers,
  they pull — are simple and settled (ADR-0008, ADR-0019).
- Reads are not shaped like the data. The domain is a resource graph —
  scalar attributes plus relationships that are **one**, **many**, or
  **paginated** (JSON:API's three relationship kinds; GraphQL's nodes and
  edges/connections) — but the engine speaks flat subsets, with
  relationships bolted on through a separate `Related` module and
  pagination existing only at the query root.

## Decision

Rebuild the public API around **six concepts**. Everything else becomes an
implementation module (still tested, still documented for contributors, no
longer in the package index) or an option on one of the six.

### Node — the resource

A **Node** is a typed resource: scalar attributes plus **edges** to other
nodes, each edge `one`, `many`, or `paginated`. Defined with Effect Schema;
ids are branded per node type.

```ts
const Product = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories"),
    variants: Edge.many("variants"),
    reviews: Edge.paginated("reviews"),
  },
});
```

Core owns this model (no new core dependency). `@thomasfosterau/legation-jsonapi` becomes
the first-class bridge: an effect-jsonapi `Resource` graph converts to and
from Nodes trivially (`Node.fromResource` / endpoint derivation), so a
JSON:API app defines its domain **once**.

### Collection — the named set

A **Collection** is the named set of one Node type that clients materialize
and query — derived directly from the Node definition plus per-collection
concerns (id extraction where non-standard, denormalized auth keys). The
registry of collections is the shared domain module both sides import.

### Edges are dependent collections

A `many` or `paginated` edge from `products` to `reviews` **is** the
dependent collection `reviews where productId = <parent id>` — an edge is
a _view_, never storage. The foreign key on the child node is the single
source of truth; a `one` edge is the reference side of the same key. This
identity is what makes the rest of the system line up: the edge's sync
window is a subset with an equality predicate on the key, ADR-0023's fine
fan-out topic is that same equality, and ADR-0015's relationship-scoped
auth keys (`cartItems.userId`) are edges too. **One foreign key powers the
join, the sync window, the auth scope, and the fan-out topic.**

Consequences of taking that seriously:

- **Declare the key once, name both directions.** The child declares the
  reference (`product: Edge.one("products", { via: "productId" })`); the
  parent's collection-valued edge is declared as its **inverse**
  (`reviews: Edge.paginated("reviews", { inverse: "product" })`) rather
  than as an independent fact that can drift (the commerce app currently
  declares `variants.productId` and `products.variants` separately, by
  hand). Edges reference their target **by name**, closed through the
  registry — which also removes the type-level recursion that eager
  resource-type expansion forces on mutually-referencing definitions.
- **The replica is normalized.** A node lives exactly once in its
  collection; root and edge windows hold _memberships_, never copies. A
  review reached through a product's edge and through a root query is one
  row — one update, and every window containing it re-emits. (The
  deliberate contrast with document-store nesting.)
- **Order belongs to the paginated edge's declaration**
  (`Edge.paginated("reviews", { order: ["-createdAt"] })`): connection
  cursors need a stable order, so it is part of the edge's identity, not a
  per-query choice.
- **Many-to-many is modeled explicitly** through an edge node — a
  join-table Node with two `one` edges — traversed as two hops. A
  `through` shorthand that flattens the hop is future sugar, not model.
- **Dependency is not cascade.** Deleting a parent is the backend's rule
  (Postgres `ON DELETE ...`); the replica converges through ordinary
  window diffs. The engine defines what an edge _shows_, never what a
  write _does_.

### Query — the read

One declarative read concept, replacing `Subset` + `Predicate` + named
queries + `Related` at the surface:

```ts
Query.make({
  collection: "products",
  where: { categoryId: "c-audio" },
  include: { variants: true, reviews: { first: 10 } }, // edges; paginated edges take cursors
  order: ["name"],
  first: 20,
  after: cursor,
});
```

Named/parameterized queries (server-resolved) are the same concept with a
name and args schema. Internally a Query compiles to a **plan** of sync
windows — the root window plus one window per traversed edge, including
per-parent cursor windows for paginated edges — which is what CVRs track
and pulls diff. `Subset`/`Predicate` survive as the plan's vocabulary,
internal. Aggregates are query projections (`Query.aggregate`).

**Paginated edges are first-class sync units**: a `(parent node, edge,
cursor window)` triple has its own CVR window, its own patches, and its own
protocol representation, exactly like a root window. This is the largest
piece of new engine work in this ADR and the price of matching the
JSON:API/GraphQL-connections model honestly.

### Mutation — the write

`Mutator` renamed to its noun and otherwise unchanged: a named,
schema-validated intent defined once and executed twice (optimistically on
the Client, authoritatively on the Backend), journaled, rebased, with
permanent rejections acknowledged-and-skipped (ADR-0008 untouched).

### Client — one per thread

The single client-side object. It runs many queries and mutations; **where
a query is answered is configuration, never a concept the UI sees**:

1. **Replica** — the query's plan is covered by active subscriptions: answer
   synchronously from the local store, live via `observe`.
2. **Host** — this Client is connected to an engine elsewhere (service
   worker, Electron main, a daemon): reads and writes cross the channel;
   observing auto-registers (the ledger semantics from ADR-0021 carry over).
3. **Server** — the plan is not covered locally: the read falls through to
   the server (evaluated under the same auth filters, point-in-time, no CVR
   registration). `observe` upgrades a fallthrough into a subscription.

```ts
Client.make({ collections, mutations, transport, store, ... })  // owns the engine
Client.connect({ channel, collections, mutations })             // thin client over a host
```

`ClientEngine`, `ClientView`, `Mirror`, `EngineHost`, `MirrorChannel`, and
`MirrorProtocol` all become internal modules behind these two constructors.
`ServiceWorkerHost` (browser package) remains the packaged host composition.
The sync-protocol identity (clientId, client group, CVR cookie) is the
Client's internal state, configured at construction — resolving the
vocabulary collision between "client the object" and "client the protocol
identity" in the object's favor.

### Server — one per backend

The single server-side object, absorbing `SyncServer`, `Cvr`,
`InvalidationBus`, `BusBrokers`, `HintSource`, and `SyncRoom`:

```ts
Effect.gen(function* () {
  const server = yield* Server.make({
    backend, // the storage contract (unchanged seam)
    auth: { policy, identity }, // deny-by-default filters + identity resolver
    queries, // named-query resolvers
    // options: cvrStore (defaults to memory), bus broker (defaults in-process),
    // hint sources (e.g. SQL polling), rooms
  });
  server.handler; // mount on any router / carrier
  yield* server.broadcast({ collection: "orders", ids: ["o-1"] });
});
```

**`broadcast` is the one server-side verb for "these resources changed":**
mutator writes call it implicitly; out-of-band writers (cron, admin tools,
anything bypassing mutations) call it explicitly. Underneath it is
unchanged ADR-0019 machinery — hint → poke → pull, hints droppable because
pull is the correctness path — but the developer story is one line.

#### Deployment shape: Cloudflare Workers as the reference topology

`Server` is a **logical** object whose parts deploy separately; the
reference distributed topology (a `@thomasfosterau/legation-cloudflare` adapter, the
server-side sibling of `@thomasfosterau/legation-browser`'s `ServiceWorkerHost`):

- A stateless **Worker fetch handler** serves the REST/JSON:API baseline
  against the backend and routes `/sync` WebSocket upgrades to the user's
  Durable Object.
- A **per-user Durable Object** is the sync room: it holds the user's
  WebSockets (hibernation-friendly — pokes are contentless), runs
  `server.handler` for push/pull, and keeps that user's CVRs in DO
  transactional storage (co-located, superseding ADR-0011's shared-KV
  variant for this topology).
- **Per-collection/edge Durable Objects** are the invalidation bus,
  sharded: `broadcast` publishes to the shard, the shard pokes registered
  user DOs. Fan-out is hint-only — pull through the user DO remains the
  correctness path. Sharding is collection/edge-level at the base (an
  insert matches predicate windows no per-node shard knows about), with
  per-node shards as an optimization for hot documents; the Node/Edge
  graph makes hint routing derivable (a `reviews` write carrying
  `productId` touches the `(products/id).reviews` edge window).
- **Authoritative data stays in the backend** (D1 fits the existing SQLite
  executor seam) — Durable Objects hold connections, CVRs, and fan-out
  registrations, never the source of truth, keeping predicate evaluation
  in one place and the BYO backend contract intact.

### What leaves the index

`LiveView`, `LiveQuery`, `Subscriptions`, `EngineAtoms`, `PromiseFacade`,
`Hash`, `Protocol`, `Introspection`, `Telemetry`, `SpecExport` move to
internal modules or subpath exports for tooling. Target surface:
**Node, Edge, Collection, Query, Mutation, Client, Server, Backend** (+
`Errors`), with bindings exposing `useQuery`/`useMutation` over a Client.

## Consequences

- **One domain definition** end to end; the JSON:API duplication in the
  example app dissolves; GraphQL-style APIs map onto the same Node/Edge
  shape.
- **Breaking across every package** (0.x): this is a staged program, not a
  PR — (1) this ADR + CONTEXT.md glossary rewrite; (2) Node/Edge/Collection
  model; (3) Query unification compiling to plans; (4) Client facade over
  engine/mirror; (5) paginated-edge sync windows (CVR + protocol); (6)
  three-tier fallthrough reads; (7) Server facade + `broadcast`; (8)
  bindings rework (dovetails with the effect-svelte upstream additions);
  (9) the jsonapi bridge package; (10) example-app migration and docs.
- Fan-out routing is designed in the companion ADR-0023 (topic-derived
  fan-out over the Node/Edge graph's derivable set).
- **Paginated edges** and **server fallthrough reads** are genuinely new
  engine capabilities with their own correctness questions (per-edge CVR
  windows; staleness semantics of unsubscribed reads) — each gets its own
  design note within the program.
- ADR-0008's sync model, ADR-0009's BYO backend, ADR-0010's service-worker
  deployment, and ADR-0021's one-surface principle are all **unchanged
  underneath** — this ADR re-draws where the public API sits over them.
- The `TabMirror → Mirror` rename (#87, merged) remains the internal
  vocabulary; this ADR takes `Mirror` out of the public API entirely, so
  the app-facing name stops mattering.

## Amendment (2026-10-23, #208): shared anonymous CVRs

The per-client reference topology has one exception, [ADR-0032](0032-shared-anonymous-cvrs.md). A subscription whose collection's auth filter is a constant for the anonymous identity, checked when the policy is built, shares one CVR keyed by (subscription, cookie generation). It lives in a shared room rather than a user's room, its pull is edge-cacheable, and its pokes route per topic. Everything else keeps per-client CVRs and per-user rooms. Designed now and built when an adopter needs it.
