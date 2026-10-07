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

## Addendum: compacting the unpushed tail (#117, #249)

"Pushed journal entries never change" is the boundary; the unpushed tail is local and may be compacted (paced mutations drop superseded entries). The backend's ledger still requires a client's ids to arrive without gaps, so the client **renumbers** the surviving unpushed entries contiguously, in order, and rewinds its id counter; the backend is not asked to accept gaps. An entry a push has been attempted for, successful or not, is frozen: a lost response does not prove the backend did not apply it, and renumbering an applied entry would get a later write skipped as a duplicate. Clients therefore record, durably and before a request leaves, the highest id each push may have sent (`ClientStore.markSent`), and treat a journal found at boot, or hydrated from a snapshot, as already sent.

## Addendum: the push acknowledgement and the overlay (#286)

The Decision says a pending mutation's optimistic effects are dropped "only when that mutation's authoritative outcome is observed — never merely when the request resolves". Before #286 the engine dropped them at the push acknowledgement, so an observer saw the pre-mutation value until the next pull. The engine now follows the rule as written.

- **Push ack.** The backend applied the entries the response covers. They are trimmed from the journal, so they are never sent again, and parked in an in-memory, oldest-first **acknowledged tail**. The overlay replays that tail ahead of the pending journal, so a push reveals nothing. A permanently rejected entry was not applied and leaves the overlay at its push.
- **Pull.** The pull's patch carries the effects of everything its `lastMutationIds` covers, so the pull releases the tail entries it covers. The release and the cache invalidation happen together, and the rebase is revealed in one change.
- **Server ordering.** The server reads `lastMutationIds` before it evaluates the patch. A push that lands mid-pull is then left out of that pull's ids, and the client keeps its overlay until a later pull reports it. Read afterwards, the ids could report a push whose effects the patch lacks, and the client would reveal that view without them.
- **Bounds and resets.** The tail holds at most 1024 entries. Past that, the oldest are released with a `logWarning`, which is the one case where a view can still revert without a pull. An identity reset clears the tail with the rows it was overlaid on. An upgrade keeps it.
- **Durability.** The tail is process-local and is not part of a `Hydration` snapshot. A restart, or a snapshot taken, between a push ack and the next pull shows the confirmed rows until that pull lands, as before. Making the tail durable needs a `ClientStore` change, which is out of scope here.
- **MutationState.** `acknowledged` (and `mutateWithAck`'s `applied`) still fires at the push ack, meaning the backend applied the mutation. The overlay's visibility now follows the pull instead.
