# ADR-0001: Monorepo of layered sync packages

Date: 2026-06-03
Status: Accepted

## Context

The repository began as a single package (`@thomasfosterau/effect-chancery`) of JSON:API sync helpers. The product goal is much larger: a client sync engine, a TanStack-Query-style query manager, a write-through cache engine usable in service workers/edge runtimes, and a server-side sync engine with client fan-out. These have distinct consumers (browser apps, service workers, servers) and distinct dependency footprints, but share core concepts (keys, caching, protocol).

## Decision

Restructure into a bun-workspaces monorepo with five packages:

- `@thomasfosterau/effect-sync-core` — a deliberately **large core** containing every shared primitive (keys, cache store + engine, queries, pagination, mutations, outbox, protocol, transports, conflict resolution, promise facade). The other packages stay thin.
- `@thomasfosterau/effect-sync-client` — client query/mutation/subscription manager and offline sync client.
- `@thomasfosterau/effect-sync-cache` — standalone write-through cache engine for service workers and edge runtimes.
- `@thomasfosterau/effect-sync-server` — server-side sync hub with fan-out.
- `@thomasfosterau/effect-sync-jsonapi` — the legacy JSON:API code, repositioned as a protocol adapter.

Build with TypeScript project references; test with a single root vitest config that aliases workspace packages to source; release with changesets.

## Consequences

- Each runtime audience installs only what it needs; `effect` is a peer dependency everywhere so consumers control the single Effect instance.
- The "large core" choice means most cross-cutting changes land in one package, and dependents rarely need lockstep changes; the cost is that core's API surface is wide.
- `@thomasfosterau/effect-chancery` is superseded; its code lives on in `effect-sync-jsonapi`.
