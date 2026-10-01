# ADR-0005: Per-key monotonic versions with push-time conflict detection

Date: 2026-06-03
Status: Superseded by [ADR-0008](0008-mutation-log-rebase-with-cvr-patches.md)

## Context

A sync engine must decide how clients and servers detect conflicting writes. Options ranged from full CRDTs, through vector clocks, to simple per-key version counters with server-side arbitration.

## Decision

The server store assigns each key a **monotonic integer version**, incremented on every write. Clients include the `baseVersion` they last saw when pushing a mutation. The server compares: if `baseVersion` differs from the current version, the push result is a `Conflict` carrying the server's current entry; otherwise the write is applied and fan-out proceeds.

Conflict _resolution_ is a client concern: the client applies a `ConflictStrategy` (`preferLocal` re-pushes, `preferRemote` accepts the server entry, `lastWriteWins`, `fail`, or custom merge).

## Consequences

- Simple to implement and reason about; no clock synchronization or CRDT machinery.
- Concurrent edits to the same key are serialized by the server; the losing client must merge or retry — acceptable for the target use cases (CRUD-ish app data, not collaborative text).
- A future CRDT/merge layer can be added as a different `ConflictStrategy` without protocol changes (the protocol already carries values and versions).
