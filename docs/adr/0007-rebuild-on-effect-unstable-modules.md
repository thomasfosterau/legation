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
