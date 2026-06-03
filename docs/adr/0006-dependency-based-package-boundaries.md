# ADR-0006: Dependency-based package boundaries (two-package monorepo)

Date: 2026-06-03
Status: Accepted — supersedes ADR-0001's five-package split

## Context

ADR-0001 split the monorepo into five packages along audience lines: core, client, cache, server, jsonapi. In practice, client, cache, and server each depended on nothing but `effect` and core — the split created packaging overhead (versions, releases, cross-package type resolution, README duplication) without isolating any real dependency.

## Decision

Package boundaries are drawn by **dependency footprint**, not by audience:

- Everything implementable with a dependency on `effect` alone lives in `@thomasfosterau/effect-sync-core`. This includes the primitives, the client query/mutation/subscription manager, the offline sync client, the service-worker/edge cache engine, and the server-side sync hub.
- Anything that brings additional dependencies or binds to a specific protocol/framework gets its own package. Today that is `@thomasfosterau/effect-sync-jsonapi` (JSON:API adapter); future examples: a React bindings package (depends on `react`), SQL-backed stores (depend on drivers).
- **Runtime globals count as dependencies.** Code that requires browser-only globals (`indexedDB`, the DOM `WebSocket`) lives in `@thomasfosterau/effect-sync-browser`; code that requires Node built-ins or Node-ecosystem packages (`ws`) lives in `@thomasfosterau/effect-sync-node`. Core must run identically in browsers, workers, edge runtimes, and Node.

Within core, the former package boundaries survive as module groups (`QueryClient`/`SyncClient`/`ClientFacade`, `WriteThroughCache`/`HttpCache`/`KeyValueStoreAdapter`, `ServerStore`/`Sessions`/`SyncHub`/`ServerFacade`), all exported as namespaces from the single entry point.

## Consequences

- One version, one changelog, one README for the whole engine; consumers never juggle compatible version ranges between core/client/cache/server.
- Tree-shaking (`sideEffects: false`, namespace exports) keeps bundle size proportional to what's imported, so merging does not bloat browser bundles.
- The "is this core?" test for future contributions is mechanical: _does it need a dependency beyond `effect`?_
- Server-only modules (SyncHub) ship in the same artifact browsers download metadata for; this is a documentation concern (the module map labels each layer), not a runtime cost.
