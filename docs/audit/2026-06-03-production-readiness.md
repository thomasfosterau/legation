# Production-readiness audit — 2026-06-03

Audit of the repository as found (single-package `@thomasfosterau/effect-chancery`, commit `19a1631`) against the target feature set:

1. A core client sync engine built using Effect primitives, drivable both from Effect code and (via a promise facade) from non-Effect code/UI frameworks
2. A strong client-side query/mutation/subscription manager (TanStack-Query-like)
3. A write-through cache engine (not a full sync engine) usable in service workers and edge runtimes, supporting paginated queries
4. A write-through server-side sync engine that fans out updates to clients

## State as found

**What existed and worked**

- A single ~500-LOC package of JSON:API helpers: types, plain-class errors, fetch/create/update/delete helpers, naive remote↔local sync, in-memory storage
- Healthy tooling: bun, TypeScript strict mode, oxlint, prettier, vitest (14 passing tests), fallow, changesets, CI + release workflows
- Pinned Effect v4 beta dependency, correct usage of `effect/unstable/http` HTTP client

**Gaps against the target feature set** (none of these existed)

| Target feature                                                 | Status as found     |
| -------------------------------------------------------------- | ------------------- |
| Core sync engine (keys, caching, dedupe, invalidation, events) | ❌ Missing entirely |
| Query/mutation/subscription manager                            | ❌ Missing entirely |
| Write-through cache engine (SW/edge, pagination)               | ❌ Missing entirely |
| Server-side sync engine with fan-out                           | ❌ Missing entirely |
| Promise facade for non-Effect consumers                        | ❌ Missing entirely |
| Offline support (outbox)                                       | ❌ Missing entirely |
| Monorepo structure                                             | ❌ Single package   |

**Code-quality issues in the existing package**

- Errors were plain classes (not `Data.TaggedError`) — not yieldable, no `catchTag` support, no `Error` prototype
- No schema validation of JSON:API responses (`as JsonApiDocument` cast)
- No retry/timeout policies on HTTP calls
- Conflict detection only via HTTP 409; the `"local"` conflict strategy silently skipped pushing (surprising semantics)
- `fetchResources` ignored pagination links entirely
- Repository name (`effect-synchronizer`), package name (`effect-chancery`), and changeset metadata disagreed; the pending changeset referenced a package name that could never be published from this repo
- CI ran the test suite twice (once plain, once for coverage); no coverage thresholds
- `CLAUDE.md` referenced an `effect-solutions` CLI and domain-docs files (`CONTEXT.md`, `docs/adr/`) that did not exist in the environment/repo

## What was done in this audit's remediation (this branch)

134 tests pass across the monorepo; every CI gate (install, format, lint, build, typecheck incl. tests, coverage, fallow audit) is green.

- **Monorepo restructure** (ADR-0001, consolidated to two packages by ADR-0006): bun workspaces, TS project references, root vitest with workspace aliases, per-package changesets. Client/cache/server functionality lives in core (dependency-based boundaries); jsonapi is the first protocol adapter package.
- **`effect-sync-core`** (106 tests) — the whole engine, organized in four module layers:
  - _Primitives_: SyncKey, tagged Errors, CacheStore/MemoryCacheStore, SyncCache engine (read-through, write-through, dedupe, SWR, invalidation, events), Query, Pagination, Mutation (optimistic + rollback), Outbox, Protocol, Transport (+ in-memory pair), Versioned conflict strategies, PromiseFacade
  - _Client_: QueryClient (fetch/observe/invalidate/paginated), MutationState, transport Subscriptions, offline SyncClient, ClientFacade
  - _Cache engine_: WriteThroughCache, HttpCache for service workers, KeyValueStoreAdapter persistence
  - _Server_: ServerStore (versioned), Sessions registry, SyncHub (subscribe/push/pull/ping, write-through + fan-out, conflict detection), ServerFacade
- **`effect-sync-jsonapi`** (28 tests): legacy code migrated, errors upgraded to `Data.TaggedError`, adapter integrating JSON:API resources with the core engine (query/pagination/mutation descriptor builders), request-building deduplicated
- **Docs**: root README, per-package READMEs, CONTEXT.md glossary, ADRs 0001–0006, this audit
- **CI**: single coverage test run, coverage-aware fallow audit, monorepo-aware quality gates

## Remaining work before production (tracked as GitHub issues)

### Completed in this branch (second pass)

1. ~~**Schema validation at boundaries**~~ — DONE (#11): `ProtocolSchema` codecs for every wire message, `JsonApiSchema` for documents, validated KeyValueStore reads
2. ~~**WebSocket transports**~~ — DONE (#12): browser `WebSocketTransport` (ClientTransport) + node `WebSocketServer` (ServerConnection acceptor); SSE fallback remains open
3. ~~**Client reconnection hardening**~~ — DONE (#13): resubscribe + pull-on-reconnect, PushAck correlation with conflict strategies, push backoff
4. **Persistent store adapters** — PARTIAL (#14): IndexedDB CacheStore done (browser package); SQL/Redis ServerStore remains open
5. ~~**Coverage thresholds + integration tests**~~ — DONE (#15): cross-package WebSocket end-to-end suite in `tests/integration/`, vitest coverage thresholds (85/70/80/85)
6. ~~**Effect v4 beta upgrade policy**~~ — DONE (#16): weekly `effect@beta` canary workflow + documented bump procedure

### Still open

- SSE fallback transport (#12 follow-up), SQL/Redis ServerStore (#14)

### Should-have

7. Framework bindings: React hooks (`useQuery`/`useMutation`/`useSyncClient`) and a Svelte/Vue story on top of the client facade
8. Request batching/coalescing in the protocol (multiple Pushes per frame)
9. Garbage collection policy for the client cache (refcounted observers → TTL eviction like TanStack's gcTime)
10. Normalized entity graphs (entities referenced by multiple queries updated in one place)
11. Backpressure/flow control on fan-out for slow clients (PubSub strategies are in place but unconfigured)
12. Telemetry: Effect Tracer spans on cache/sync operations, metrics for hit rates and fan-out latency

### Nice-to-have

13. CRDT/merge conflict strategies beyond last-write-wins
14. Devtools (cache inspector UI)
15. Benchmarks (cache throughput, fan-out latency at N clients)

## Tooling/process notes

- `effect-solutions` CLI referenced by CLAUDE.md is not available in CI/dev containers; Effect API correctness was verified against the installed package's `.d.ts` files. Consider vendoring the guides or removing the reference. CLAUDE.md now documents the fallback.
- `fallow` is configured for a library monorepo (`publicPackages`, workspace dependency ignores, test duplication ignores) and runs coverage-aware in CI. Four small duplication clone groups remain as warnings (PubSub setup boilerplate shared by SyncCache/Outbox, internal repetition in KeyValueStoreAdapter/Sessions/Pagination) — candidates for a shared internal helper, tracked as a cleanup issue.
