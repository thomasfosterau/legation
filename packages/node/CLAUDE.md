# packages/node — `@thomasfosterau/legation-node`

The Node runtime adapter. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- `HttpSyncServer` serves the default RPC sync transport on Node's HTTP server, over HTTP POST, WebSockets or both. `node:*` imports are this package's purpose (the lint config allows them under `src/`).
- Imports from the workspace: `@thomasfosterau/legation-effect` only. Peers: `effect`, `@effect/platform-node`.
- Import `@effect/platform-node` **by subpath** (`@effect/platform-node/NodeHttpServer`), never the package root: the root re-exports `NodeRedis`, which loads the optional `redis` peer, so a consumer without `redis` could not load this package. `src/__tests__/load-without-redis.test.ts` loads the built package in a fresh Node process to pin that.
- `engines.node` is the published floor (`>=22`).

## Tests

`src/__tests__/` (Vitest project `node`). The load test needs the built `dist/` (`vp run build`).
