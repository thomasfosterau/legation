# ADR-0008: Mutation-log writes with server rebase; CVR state patches downstream

Date: 2026-06-12
Status: Accepted — supersedes ADR-0005 (per-key versions with push-time conflict detection); narrows ADR-0004 to the HTTP cache module

## Context

ADR-0005 synced state diffs: clients pushed new values per key with a `baseVersion`, the server detected conflicts by version mismatch, and clients resolved them with merge strategies (`preferLocal`, `preferRemote`, `lastWriteWins`, custom). State diffs cannot preserve intent under concurrency — "increment" replayed as "set to 5" clobbers — so every conflict needs an explicit strategy, and offline queues of state diffs compound the problem. The battle-tested alternative (Replicache, Zero, and the shape of Effect's own EventLog) is to sync _intents_: named mutator functions executed optimistically on the client and authoritatively on the server, with the client rebasing pending intents on top of incoming authoritative state.

Downstream, two models were considered: replicating event logs per scope (simple, offline-natural, but whole-scope sync only) and server-computed state patches against a per-client view record (partial sync, read authorization, large datasets, more server machinery).

## Decision

**Writes**: a mutation is a named, schema-validated intent (mutator name + args) with a per-client sequential mutation id. Mutations append to a durable client journal, apply optimistically to local collections, and are pushed to the backend, which executes its own (possibly different) implementation of the mutator transactionally — the mutation-id bump atomic with the effects, giving exactly-once in-order application.

**Downstream**: the server tracks a client view record (CVR) — exactly which row versions each client holds per subscription — and computes minimal row put/delete patches. `Pull(cookie) → patch` is the canonical path; sync must be correct over pull alone (periodic HTTP-only sync works). Live delivery of the same patches over a streaming connection, and pokes, are latency optimizations.

**Conflicts**: there are no merge strategies. On every incoming patch the client rewinds to authoritative state, applies the patch, replays pending mutations on top (which may compute different effects against newer state), and reveals the result atomically. A pending mutation's optimistic effects are dropped only when that mutation's authoritative outcome is observed — never merely when the request resolves.

ADR-0004's mark-stale invalidation semantics survive only in the HTTP cache module; collections have no stale marking — they have patches and the overlay.

## Consequences

- Intent-preserving conflict resolution with no strategy vocabulary to teach; the cost is that every write must be expressible as a named mutator (no ad-hoc `set(key, value)` sync).
- True partial sync, per-subscription read authorization, and large backing datasets become possible; the price is real server machinery (CVR storage, diffing) — contained by ADR-0009's contract split.
- Offline-first falls out: the journal is durable, pulls are resumable from a cookie, and rebase handles whatever happened while offline.
- An unrecognized or lost cookie degrades safely to a reset patch (clear + full puts), so CVR storage may be ephemeral.
