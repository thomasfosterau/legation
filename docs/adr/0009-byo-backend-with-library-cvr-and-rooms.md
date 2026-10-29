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

## Amendment (2026-10-15, #365): the rejection list

`Backend` gains a required method, `rejections(context)`, which lists the permanent rejections a client group still remembers, each with the reason `applyMutations` reported for it. It is Backend guarantee 4. The sync server filters that list by a pull's watermark and returns the covered entries in `PullResponse.rejected`, so a client whose push response was lost learns the outcome from its next pull (see ADR-0008's amendment for #365). Every backend supplies it: `MemoryBackend` and `SqlBackend` read their rejection memory, and `JsonApiBackend` reads its in-session one. `BackendContract` rule 13 checks that a rejection the backend reports is also listed by `rejections`, with the same reason. A third-party backend that omits the method fails to type-check, so a custom backend must add it before it upgrades.

## Amendment (2026-10-23, #208): shared anonymous CVRs

The per-client CVR bookkeeping has one exception, [ADR-0032](0032-shared-anonymous-cvrs.md). A subscription whose collection's auth filter is a constant for the anonymous identity, checked when the policy is built, shares one CVR keyed by (subscription, cookie generation). It lives in a shared room rather than a user's room, its pull is edge-cacheable, and its pokes route per topic. Everything else keeps per-client CVRs and per-user rooms. Designed now and built when an adopter needs it.

## Amendment (2026-10-29, #177): which contract rules types carry

A backend's `applyMutations` can now be built with `Backend.transaction(steps)`, a combinator that owns the mutation-id ledger. The store supplies its storage steps. `begin` starts a push and forgets the rejections below its floors. `open` opens the client's next mutation or reports the watermark. `run` runs the app's handler. `commit` writes the outcome with the bump. `release` gives back a unit after a transient failure. `finish` builds the result. The optional `atomically` wraps the push in the store's transaction. There is no brand and no checked constructor: a hand-assembled `Backend` still type-checks, so a bring-your-own backend author can still build one by hand.

What a backend built through the combinator gets by construction:

- **In-order, exactly-once application** (`BackendContract` rules 1–3). Mutations settle one at a time, in push order. The combinator, not the store, decides from the watermark that a mutation is a replay or a gap, and a non-positive id opens nothing.
- **The bump travels with the outcome** (rules 4, 9 and 10). The only call that hands a handler's effects to the store is `commit`, and it carries the bump. A `MutationRejected` is committed as the bump and its reason, with none of the handler's staged result. A transient failure commits nothing and releases the unit.
- **Every copy reports the committed outcome** (#355). A replay, or a copy that a concurrent call committed first, lists the committed rejection.

What stays runtime, checked by `verifyBackendContract` for every backend:

- **That `commit`, or `atomically`, is really atomic and isolated.** A type cannot see a database transaction. The combinator narrows the obligation to one primitive, but whether the primitive keeps it is behaviour. That covers rules 4 and 10 at the storage level, serialisability across groups (rule 11), and visibility before the bump (each backend's own mid-flight test).
- **A store whose effects live in the unit rather than in the staged result must discard them on a rejection.** `MemoryBackend`'s effects are its staged log, which the combinator withholds from a rejected commit, so it gets this by construction. `SqlBackend`'s effects are already written inside the unit's savepoint, so its `commit` rolls the savepoint back. Rule 9 still checks that.
- **Evaluation semantics** (rule 6 and its corpus, rule 14's `evaluateMany` equivalence). ADR-0028's normative semantics and the differential harness settle these. No type is planned here.
- **Row versions, `getRows`, client-group isolation and the rejection list** (rules 5, 7, 8, 12 and 13). These are behaviour of reads, not of the ledger.

Adoption:

- `MemoryBackend` and `SqlBackend` build `applyMutations` through the combinator. `SqlBackend` does so on both orderings: claim-first inside `SqlExecutor.transaction`, and handler-then-bump on an executor without transactions (D1). On D1, `atomically` is a no-op wrapper and the bump is not atomic with the effects, exactly as before (#342).
- `JsonApiBackend` does not adopt it. Its unit of atomicity is the server's whole `atomic:operations` batch, not one mutation: a permanent rejection there drops the operation and resends the rest, and no mutation is acknowledged until the remainder applies. On the per-resource path there is nothing atomic to own: delivery is at-least-once, and it refuses a gap before any write of the push is sent. A per-mutation combinator would either lose the all-or-nothing batch or claim an atomicity the HTTP surface does not have. It keeps its own ledger and runs the contract suite as before.

The runtime suite is unchanged in scope.
