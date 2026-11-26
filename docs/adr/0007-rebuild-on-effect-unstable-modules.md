# ADR-0007: Rebuild the engine on Effect v4 unstable modules

Date: 2026-06-12
Status: Accepted — amends ADR-0003's isolation stance

## Context

Effect v4 beta has absorbed most of this library's problem space into `effect/unstable/*`: `rpc` (typed, schema-serialized, streaming RPC over HTTP/WebSocket/worker/in-memory transports), `reactivity` (Reactivity key invalidation, Atom/AtomRegistry, AtomRpc/AtomHttpApi — effectively TanStack Query for Effect), `eventlog` (local-first event journal with remote sync over RPC), `persistence` (KeyValueStore, PersistedCache), and `httpapi`. The existing engine hand-rolls parallel versions of several of these (bespoke wire protocol, bespoke transports, bespoke query client). ADR-0003 isolated unstable imports to adapter edges; continuing that policy means competing with the ecosystem this library exists to integrate with.

## Decision

Rebuild the engine assuming the unstable modules as foundations rather than edges:

- The default sync transport is built on `effect/unstable/rpc` (ADR-0008 keeps the protocol seam customisable).
- Read-side observation integrates with `effect/unstable/reactivity` (Reactivity invalidation; Atom bindings as the UI surface).
- Persistence layers build on `effect/unstable/persistence` KeyValueStore and the platform-browser IndexedDB stack.
- The journal design follows `effect/unstable/eventlog`'s journal shape where it fits, without adopting whole-log replication as the sync model (ADR-0008 chooses CVR state patches downstream).

The exact-pin policy from ADR-0003 stays: `effect` is pinned exactly and bumped deliberately, package-wide, in one PR.

## Consequences

- Deep, native integration with Effect RPC/HttpApi/Atom instead of a parallel ecosystem; dramatically less transport and query-client code to maintain.
- Double-beta exposure: unstable APIs can break on any beta bump. The exact pin plus the weekly beta-canary workflow contain this; bumps may now require real migration work rather than mechanical fixes.
- The "is this core?" packaging test (ADR-0006) is unchanged — unstable modules ship inside `effect` itself, so they add no dependency footprint.

## Amendment (2026-11-26): EventLog is neither the sync model nor the client journal

The Decision says the journal design "follows `effect/unstable/eventlog`'s journal shape where it fits". Reviewed against `effect/eventlog` as shipped in effect 4.1 (journal, remotes, `EventRow`, IndexedDB and SQL journals, remote compaction), it fits in neither place, and the engine does not build on it.

- **Sync model.** EventLog replicates one identity's whole log between that identity's devices, through a server that stores and relays entries (and, encrypted, cannot read them). Every device applies every event, ordered by the writer's UUID v7 clock, and handlers resolve conflicts. ADR-0008 instead makes the backend authoritative, syncs CVR row patches per subscription, authorizes reads per subscription (ADR-0015) and sits over an existing REST backend (ADR-0016, ADR-0029). Whole-log replication gives up all four.
- **Client journal.** `ClientStore` keeps per-client contiguous mutation ids with renumbering of the unpushed tail, `markSent`, the bounded acknowledged tail released only by a pull, pull release records and quarantine by identity, and commits rows, cookie, journal trim and tail release in one atomic batch. `EventJournal` acknowledges per-remote sequences over UUID v7 entries, and commits its entry separately from the handler's projection unless both share a connection, so a crash can keep a local write's projection while losing the entry. Adopting it would weaken the store and change a storage format that is protocol.
- **Multi-tab.** EventLog's browser journal serializes tabs with Web Locks around one IndexedDB database. ADR-0010's single host with tab mirrors already covers this, and `ElectedHost` uses the same Web Locks.

What remains open is a separate, optional use: an end-to-end-encrypted EventLog for data private to one person across their devices (drafts, preferences), projected into a client-local collection beside the synced ones. It is not planned, and needs its own ADR if an app asks for it.
