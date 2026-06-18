# Zero Sync feature-parity audit — 2026-06-18

Audit of the effect-sync monorepo (commit on `claude/package-zero-sync-audit-papsbe`) against
[Rocicorp's Zero](https://zero.rocicorp.dev) (which reached
[1.0 in June 2026](https://www.infoq.com/news/2026/06/zero-version-1/)).

**Goal.** Not technical parity — by design this library is framework-, storage-, and
transport-agnostic where Zero is a Postgres-backed, WebSocket, TypeScript-only product
(ADR-0002, ADR-0009). The goal is to confirm there is a **good story for every Zero use case**,
and to flag the cases where that story is currently weak or missing.

## Legend

| Mark | Meaning |
| ---- | ------- |
| ✅ | Strong story — parity or better |
| ➕ | Beyond Zero — capability Zero does not have |
| 🟡 | Workable — a story exists, but with caveats, more app work, or stated limits |
| 🔴 | Gap — weak or missing story; recommend action |

## Summary scorecard

| # | Zero use case | effect-sync story | Verdict |
| - | ------------- | ----------------- | ------- |
| 1 | Schema definition (types, enums, optional) | Collections + Effect Schema, runtime codecs | ✅ |
| 2 | Schema **relationships** (one/many/junction) | None — collections are independent | 🔴 |
| 3 | Optimistic writes + rollback | Journal + overlay + **rebase** (intent-preserving) | ✅➕ |
| 4 | Custom mutators (client + server, server authority) | Mutators: client handler + backend handler, atomic mutation-id | ✅ |
| 5 | Mutator transactions / exactly-once | Backend contract: atomic id-bump, gap rejection, verified suite | ✅ |
| 6 | Read within a mutator | `LocalWriter.get` / backend reads | 🟡 |
| 7 | Await write result (`.client` / `.server`) | PromiseFacade + per-mutation ack | 🟡 |
| 8 | ZQL filtering (`where`, and/or/not, operators) | `Predicate` expression tree | ✅ |
| 9 | ZQL ordering / limit / cursor pagination | `Subset` (orderBy, limit, cursor) | ✅ |
| 10 | ZQL **relationships / joins** (`related`, `whereExists`) | None — single-collection only | 🔴 |
| 11 | Incremental view maintenance (IVM) | Full re-evaluation over the in-memory mirror | 🟡 |
| 12 | Synced (named, server-defined) queries | Client predicates + server auth filter | 🟡 |
| 13 | Read permissions — ownership / row-level | Auth filter → predicate over `ctx` (deny-by-default) | ✅ |
| 14 | Read permissions — relationship-scoped visibility | Predicate can't traverse collections | 🔴 |
| 15 | Write permissions | Plain code in backend mutator handler | ✅ |
| 16 | Auth tokens (JWT / cookie forwarding) | `SyncContext` (app verifies) + middleware | ✅ |
| 17 | Partial sync (query-driven) | Subsets + CVR + minimal patches | ✅ |
| 18 | Preload + query TTL / lifetime | Subscribe = preload; no TTL/lifecycle layer | 🟡 |
| 19 | Realtime delivery | Poke-then-pull over invalidation bus | ✅ |
| 20 | Transport | Carrier-agnostic seam (RPC default; HTTP POST + WS) | ✅➕ |
| 21 | REST / external-writer access to mutators | RPC push is HTTP; REST routes are thin app code | 🟡 |
| 22 | Backend / storage | **BYO backend contract** — any storage | ➕ |
| 23 | Turnkey Postgres (replication, CDC) | Not shipped — app evaluates subsets + emits hints | 🔴 |
| 24 | Multi-instance / distributed deployment | Bus-broker + KV-CVR seam designed; no concrete brokers | 🟡 |
| 25 | Framework bindings (React/RN/Solid/Svelte) | Effect Atom bindings + PromiseFacade; no idiomatic hooks | 🔴 |
| 26 | Native mobile clients | Web-only for Zero; Swift/Kotlin **ports** here (skeleton) | 🟡➕ |
| 27 | Offline writes | Durable journal, resumable pulls — first-class | ➕ |
| 28 | Schema migration / evolution | No expand-contract / backfill story | 🔴 |
| 29 | Observability (OpenTelemetry) | Effect Tracer/Metrics available but not wired | 🔴 |
| 30 | Aggregations / full-text search | Absent (Zero roadmap, also absent there) | 🟡 (parity) |
| 31 | HTTP response cache (SWR, tags) | Cache API module | ➕ |

## Where the story is strong (parity or better)

**Writes are the best-matched area, and arguably better.** Zero's custom mutators run
optimistically, then roll back pending local effects if the server diverges
([mutators](https://zero.rocicorp.dev/docs/custom-mutators)). effect-sync's model (ADR-0008)
is the same shape but resolves conflicts by **rebase replay**: on every authoritative patch the
client rewinds, applies the patch, and *replays* pending mutators against newer state
(`ClientEngine.ts`). This preserves intent (`increment` stays an increment) where a
rollback-and-reapply of a recorded effect cannot. The backend contract
(`BackendContract.verifyBackendContract`) makes exactly-once, in-order, atomic-id-bump
semantics an executable test every backend must pass — Zero guarantees this by owning Postgres;
here it is contractual and checkable.

**Flat queries reach parity.** `Predicate` (eq/ne/gt/gte/lt/lte, `In`, and/or/not) plus
`Subset` (orderBy, limit, cursor) cover ZQL's non-relational surface, and the predicate tree is
serializable and evaluated identically on client mirror and backend (`Subset.apply` is the
reference semantics). Cursor pagination matches Zero's `start()` model (widen the subset, don't
fetch detached pages).

**Ownership-based read auth reaches parity.** An `AuthFilter` is
`(SyncContext) => Effect<Predicate>`, deny-by-default, AND-ed into every subscription
(`Authorization.ts`). `ownerId == ctx.userId` is exactly Zero's ownership pattern, enforced
server-side and impossible for the client to widen. Write auth is plain code in the backend
mutator handler — identical to Zero's "permissions are just code in the mutator."

**Three capabilities go beyond Zero:**

- ➕ **BYO backend over any storage** (ADR-0009). Zero is structurally Postgres
  (logical-replication pipeline, `zero-cache` replica). Here the library owns the mechanical
  parts (CVR storage/diffing, cookies, fan-out) and the app implements two operations against
  *its own* storage. No replication pipeline to run, no 100 GB / NVMe ceiling.
- ➕ **Offline writes.** Zero explicitly does **not** support offline writes
  ([when-to-use](https://zero.rocicorp.dev/docs/when-to-use)). Here the journal is durable and
  pulls resume from a cookie, so offline-first falls out of the model (ADR-0008).
- ➕ **Transport agnosticism + HTTP response cache.** Pull-only correctness means periodic
  HTTP sync works with no streaming connection; the Cache API module (SWR + tag invalidation)
  has no Zero equivalent.

## Where the story is weak — recommendations

The gaps cluster around Zero's **signature feature: relational, server-authored, incrementally
maintained queries.** Everything below is a recommendation, not a defect against the current
ADRs.

### 🔴 1. Relationships & joins (rows #2, #10, #14) — the headline gap

This is the single most important gap, because three Zero use cases collapse into it:

- **Query-time joins.** ZQL's `related()` and `whereExists()` let a client ask for "issues with
  their comments" or "issues where the project is active." effect-sync live queries are
  strictly single-collection (`LiveQuery.ts`, `Subset.ts`); cross-collection composition is
  app-level and manual.
- **Relationship-scoped read auth (#14).** Because an auth filter is a predicate over *the
  row's own fields*, "visible if you are a member of the issue's project" is inexpressible
  without denormalizing membership onto every row. Zero expresses this naturally because the
  permission runs as a query with joins.
- **Schema relationships (#2).** Collections have no `one()`/`many()`/junction declarations, so
  there is nothing for a join planner or a relationship-aware auth filter to build on.

**Recommendation.** Decide and document the relational story explicitly. Options, roughly in
increasing order of effort:
  1. **Document denormalization as the intended pattern** (mutators maintain derived/embedded
     fields; membership flags live on the row). Cheapest; keeps the engine flat; should ship
     regardless as guidance.
  2. **Add relationship declarations to collections** plus a client-side `related()` that runs
     N+1 lookups over the already-synced mirror (no new protocol — relations resolve against
     local rows). Covers most read-side join use cases.
  3. **Relationship-aware auth filters** — allow an auth filter to reference another
     collection's rows (e.g. a membership set) so project-scoped visibility works without
     denormalization. Needs a server-side join-evaluation seam in the backend contract.

Pick at minimum (1) now and capture the rest in an ADR; this is where "a good story for every
Zero use case" is currently missing.

### 🔴 2. Synced/named server queries (#12)

Zero's [synced queries](https://zero.rocicorp.dev/docs/synced-queries) let the **server define
and rewrite** a named query with arbitrary code, putting permissions on the query path. Here the
server's only lever is AND-ing an auth-filter predicate onto a **client-authored** subset; it
cannot author the query, add joins, or run arbitrary shaping logic. For pure narrowing this is
equivalent and simpler; for "the server decides what this named query returns" it is not.

**Recommendation.** Add a **named server-side subset provider**: a registry mapping a query name
+ args to a server-computed `Subset` (or, with #1.3, a relational query). Clients invoke
`("activeProjectsForUser", {…})` instead of shipping a raw predicate. This also gives a natural
home for preload and TTL (#18).

### 🟡 3. Incremental view maintenance (#11)

Zero's ZQL incrementally maintains query results; effect-sync re-runs `Subset.apply` in full
over the mirror on every change. Partial sync keeps each client's working set small, so this is
**fine in practice today**, but it is a real difference at large local set sizes and should be
stated, not left implicit.

**Recommendation.** Document the bounded-working-set assumption as the performance contract for
live queries; note incremental maintenance as a future optimization (it becomes more pressing if
#1.2 lands and queries fan across relations).

### 🔴 4. Framework bindings (#25)

Zero ships React, React Native, and SolidJS bindings. effect-sync exposes Effect `Atom` bindings
(`LiveQuery.ts`) and a `PromiseFacade`, which is the agnostic substrate — but no idiomatic
`useQuery`/`useMutation` hooks. This was already flagged "should-have" in the 2026-06-03 audit.

**Recommendation.** Ship a thin `@thomasfosterau/effect-sync-react` (hooks over the mirror +
PromiseFacade), and at least a documented Svelte/Solid recipe. Small surface, large adoption
impact.

### 🔴 5. Turnkey backend example (#23)

Zero's value is "point it at Postgres and go." The BYO contract is more flexible but ships only
`MemoryBackend`; there is no reference SQL backend showing subset evaluation + change-data-capture
→ invalidation hints. Adopters face exactly the "compute diffs / wire invalidation correctly"
task ADR-0009 identifies as Replicache's biggest failure mode.

**Recommendation.** Ship one batteries-included adapter (a SQL/SQLite backend: `Subset` →
WHERE-clause translation + a polling or LISTEN/NOTIFY hint source) as the canonical "how to back
this with a real database" example.

### 🔴 6. Schema migration story (#28)

Zero documents downtime-free expand/contract deploys with automatic backfill
([schema](https://zero.rocicorp.dev/docs/schema)). Row versions handle per-row change here, but
there is no documented story for evolving a collection's schema across already-synced clients.

**Recommendation.** Document an expand-contract analog (additive/optional fields tolerated by
the row codec; cookie reset as the backfill mechanism since unknown cookies degrade to a full
reset patch) and capture it in an ADR.

### 🔴 7. Observability (#29)

Zero ships OpenTelemetry. Effect gives Tracer + Metrics for free, but no spans/metrics are wired
into the engine, cache, or fan-out today.

**Recommendation.** Add Tracer spans on push/pull/rebase/fan-out and a few metrics (patch size,
fan-out latency, mirror size). Low effort given Effect; closes an enterprise-readiness gap.

### 🟡 8. Distributed deployment (#24) & external-writer REST (#21)

Both have a designed seam but no shipped concrete implementation: the bus-broker interface
(`BusBrokers.ts`) has no Redis/Durable-Object adapter, and mapping REST routes to mutators is
left to app code. These are lower priority (the seams exist) but worth one reference
implementation each.

## Net assessment

For the **interactive, permissioned, partial-sync app** Zero targets (think Linear), effect-sync
already has a credible-or-better story on writes, optimistic UX, ownership auth, partial sync,
realtime, transport, offline, and storage freedom. The **relational query family** (joins,
relationship-scoped read auth, server-authored synced queries) is where Zero is materially ahead
and where this library currently lacks a good story — addressing gap #1 (even just the
documented-denormalization tier) plus framework bindings (#4) would close the most user-visible
distance. Migrations (#6) and observability (#7) are smaller, well-scoped follow-ups.

## Recommended next actions

1. ADR + docs for the **relationship/join story** (start with denormalization guidance; scope
   local `related()` and relationship-aware auth filters). — highest impact
2. **Named server-side query provider** (carries preload + TTL). 
3. **React bindings package** (+ Svelte/Solid recipe).
4. **Reference SQL backend** (subset→WHERE + hint source).
5. **Schema migration ADR** (expand/contract + cookie-reset backfill).
6. **Tracer spans + metrics** across engine/cache/fan-out.
7. One concrete **bus broker** (Redis or Durable Object) and one **REST→mutator** recipe.
