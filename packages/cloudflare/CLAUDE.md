# packages/cloudflare — `@thomasfosterau/legation-cloudflare`

The reference deployment on Cloudflare (ADR-0022 topology, ADR-0023 topic-derived fan-out). Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- Durable Object rooms (`makeRoomClass`), topic fan-out shards (`makeShardClass`), the stateless Worker router (`routeSync`) and the D1 executor. Imports from the workspace: `@thomasfosterau/legation` only (its `./internal` and `./sql` entries included).
- `@cloudflare/workers-types` is types-only and stays an import in the emitted `.d.ts` (the build never bundles it), so it is an **optional peer** (`catalogs.peers`): a Worker project has it, and a consumer that type-checks this package's declarations needs it. Alchemy's Cloudflare provider (`@alchemy.run/cloudflare`) does not replace it: it re-exports none of the raw workerd types this package is written against (`D1Database`, `DurableObjectState`, `DurableObjectStorage`, `DurableObjectNamespace`, `WebSocket`), and its own declarations import `@cloudflare/workers-types` while declaring it only as a devDependency (checked at 2.0.0-beta.85). That is why this package is not named or built as an Alchemy package.

## Invariants

- **WebSockets carry only contentless poke frames**; data moves over stateless HTTP, so hibernated sockets cost nothing between writes.
- **Every shard call and lease registration is bounded** by `publishTimeout`: a hung shard drops its poke, it never holds a push open.
- **D1 has no interactive transactions**: the executor reports `transactional: false`, so the SQL backend runs each handler and then bumps its mutation id, not atomically. This does not meet Backend guarantee 1 (#342, #353); the `D1Executor.ts` header says what that costs. Don't document D1 as transactional.

## Tests

`src/__tests__/` (Vitest project `node`, over in-memory fakes of the Durable Object and D1 bindings).
