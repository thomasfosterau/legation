# ADR-0009: BYO backend contract; library-owned CVR bookkeeping; invalidation bus + sync rooms

Date: 2026-06-12
Status: Accepted

## Context

With CVR patches downstream (ADR-0008), someone must (a) execute mutators against canonical storage, (b) evaluate subscriptions to (row id, row version) sets, (c) store and diff CVRs, and (d) fan committed-write signals out to sessions, possibly across instances. Zero answers all four by owning a Postgres replication pipeline — heavy infrastructure and a hard coupling. Replicache answered with "bring your own backend" for everything, and computing diffs correctly proved to be its adopters' biggest failure mode. The subscription unit here is a serializable predicate expression (collection, where, order, limit), which the backend must evaluate against its own storage.

## Decision

Split the server along the line of what only the app can know:

- **The app implements the backend contract** (it owns storage): execute a named mutator transactionally with the mutation-id bump atomic in the same transaction, and evaluate an authorized subscription — auth filter AND-ed with the client predicate — to the current (row id, row version) set plus row data for requested ids.
- **The library implements everything mechanical**: CVR storage and diffing, patch computation, cookie management, session registry, the protocol, per-collection deny-by-default auth filters plus middleware, and the fan-out loop.
- **Fan-out is poke-then-pull over a pluggable invalidation bus**: after a committed push, hints (collection + touched ids) are published; each instance matches hints against its sessions' subscriptions and recomputes patches via the normal pull path. In-process PubSub is the default bus; distributed adapters (Durable Object broadcast, Redis, LISTEN/NOTIFY) are layers. Correctness never depends on the bus.
- **A packaged "sync room"** composes sessions + CVR storage + bus so the same artifact runs in-process on Node or as a Cloudflare Durable Object class.

The library ships an in-memory reference backend, predicate-evaluation helpers (in-memory filter; SQL where-clause translation), and a contract test suite (`verifyBackendContract`) every backend implementation must pass.

## Consequences

- Any storage can participate — existing Postgres schemas, Durable Object storage, KV — without the library running a replication pipeline.
- The hardest adopter task (correct diffing) moves into the library; the remaining app obligation (transactional mutator + subscription evaluation) is testable against the shipped contract suite.
- Subscription evaluation cost is the app's to manage; the middleware seam exists for cost control and rate limiting.
- The room packaging makes Durable Objects a deployment target, not a porting exercise; the bus seam keeps multi-instance Node viable.
