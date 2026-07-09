# legation

A modular sync engine built on [Effect](https://effect.website): mutation-log writes with server-authoritative rebase, CVR-tracked state patches downstream, typed collections with live queries, offline-first clients, and a customisable transport seam — designed to integrate natively with Effect's RPC, HttpApi, reactivity, and persistence modules.

## Status

**v2 rebuild in progress** (see [ADRs 0007–0011](docs/adr/)). The engine core, the default RPC transport, the runtime adapters, and multi-instance deployment work today: optimistic mutations → journal → push → authoritative backend → CVR diff → pull patch → rebase, with schema-validated mutator args end to end, pokes streamed over `effect/unstable/rpc`, an executable backend contract (`BackendContract.verifyBackendContract`), an IndexedDB client store, tab mirrors (refcounted per tab, with a liveness heartbeat) served by a (service-worker) engine host over BroadcastChannel, a Cache API HTTP cache, Node HTTP/WebSocket serving of the sync RPCs, live queries bound to `effect/unstable/reactivity` Atoms, JSON:API collection loaders, and a distributed story — a serialized invalidation bus over a broker (Redis Streams or a Durable-Object-style WebSocket relay) plus a shared-storage CVR store. All packages target **Effect v4 beta** and ESM-only consumers. APIs are pre-1.0 and will change.

## Architecture

```
        tab (UI)                    service worker host            your backend
┌──────────────────────┐      ┌──────────────────────────┐      ┌──────────────────┐
│ in-memory mirror     │      │ ClientEngine             │      │ named mutators   │
│ live queries         │◀────▶│  journal (pending        │ push │ (authoritative)  │
│ optimistic overlay   │ b'cast│   mutations)            │─────▶│ + your storage   │
└──────────────────────┘      │  ClientStore (IndexedDB) │      ├──────────────────┤
                              │  pull(cookie) → patch    │◀─────│ SyncServer       │
                              │  rebase = replay pending │ patch│  auth filters    │
                              └──────────────────────────┘      │  CVR diffing     │
                                       ▲      ▲                 │  invalidation bus│
                              ┌────────┴──────┴────────┐        │  (sync room /    │
                              │ Transport (customisable │◀──poke─│   Durable Object)│
                              │ seam; RPC default)      │        └──────────────────┘
                              └─────────────────────────┘
```

- **Writes are intents**: named, schema-validated mutators run optimistically on the client and authoritatively on your backend; conflicts resolve by replay (rebase), not merge strategies.
- **Reads are subscriptions**: collection subsets `(collection, predicate, orderBy, limit/cursor)`, narrowed by deny-by-default auth filters; the server tracks per-client view records (CVRs) and ships minimal row patches.
- **Pull is the correctness path**: periodic HTTP-only sync is fully correct; pokes and streaming are latency optimizations.
- **Bring your own backend**: implement two operations (apply mutations transactionally, evaluate a subset); the library owns CVR bookkeeping, diffing, auth, and fan-out.

See [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr/](docs/adr/) for the decisions. Coming from TanStack Query / SwiftData / SWR / Apollo? [docs/coming-from-tanstack-query.md](docs/coming-from-tanstack-query.md) maps their concepts onto this model.

### Browser topology: service worker vs. elected main-thread host

The diagram above is the **recommended** topology: the engine lives in the
per-origin service-worker singleton, so there's no leader election — the
platform provides the singleton, and closed-tab pending mutations survive in
the service worker's journal ([ADR-0010](docs/adr/0010-service-worker-hosted-client-engine.md)).

Apps that can't run a service worker (some embedded webviews, or a dev
environment where it's inconvenient) run the same host composition on a
tab's main thread instead, with `@legation/browser`'s `ElectedHost.run`
electing exactly one tab per browser profile via the Web Locks API
(`navigator.locks`) — held for that tab's whole lifetime, no voluntary
step-down. Every other tab mirrors it over the same `BroadcastChannel`; when
the elected tab closes or crashes, the browser grants the lock to the next
tab, which boots the engine against the SAME durable store (journal, rows,
cookie), resuming the CVR conversation rather than starting over. `run`
hands back one `Client` that keeps working across that promotion (the
underlying view swaps itself) and a `role: Stream<"host" | "mirror">` purely
for observability. Environments without `navigator.locks` get a documented
fallback (this module logs a warning and becomes host immediately — correct
for a single tab only), not a polyfill.

## Packages

Package boundaries are drawn by dependency footprint ([ADR-0006](docs/adr/0006-dependency-based-package-boundaries.md)).

| Package                                 | Description                                                                                                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@legation/effect`](packages/effect)   | The engine: collections, predicates, mutators, journal, client engine with rebase, protocol, transport seam (RPC default), BYO backend contract + verification suite, CVR bookkeeping, auth, invalidation bus, sync rooms, durable client store, HTTP cache interfaces |
| [`@legation/browser`](packages/browser) | Browser adapters: service-worker engine host, `navigator.locks`-elected main-thread host fallback, IndexedDB client store, tab mirrors over BroadcastChannel, Cache API HTTP cache with stale-while-revalidate                                                         |
| [`@legation/node`](packages/node)       | Node adapters: serving the default RPC sync transport over HTTP/WebSocket; distributed bus adapters planned                                                                                                                                                            |
| [`@legation/jsonapi`](packages/jsonapi) | JSON:API v1.1 collection loaders: map documents into engine collection rows (a `type` is a collection, a resource a row)                                                                                                                                               |
| [`@legation/sql`](packages/sql)         | Driver-agnostic SQL reference backend: `Subset`→`WHERE` translation (SQLite/Postgres) + a `SqlBackend` over a minimal executor seam (subset evaluation, row fetch, transactional idempotent mutation-id ledger)                                                        |
| [`@legation/react`](packages/react)     | React bindings: `EffectSyncProvider` + `useQuery` / `useNamedQuery` (live via `useSyncExternalStore`) + `useMutation`                                                                                                                                                  |
| [`@legation/svelte`](packages/svelte)   | Svelte bindings: `setEngineRuntime` + `query` / `namedQuery` (live `Readable` stores) + `getMutate`                                                                                                                                                                    |

## Quick start (in-process, today)

```ts
import { Effect, Schema } from "effect";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  InvalidationBus,
  MemoryBackend,
  Mutator,
  Predicate,
  Subset,
  SyncServer,
  Transport,
} from "@legation/effect";

// 1. Shared mutator contract (client runs it optimistically; your backend
//    runs its own authoritative version). Args are schema-validated on
//    both sides and journaled in encoded form.
const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args: any, writer) => writer.put("todos", args.id, args) },
]);

// 2. Server: reference in-memory backend + deny-by-default auth.
const server = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
    ])
  );
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

// 3. Client: optimistic mutate → push → pull → rebase.
const program = Effect.gen(function* () {
  const handler = yield* server;
  const engine = yield* ClientEngine.make({ clientId: "c1", clientGroupId: "g1", mutators }).pipe(
    Effect.provideService(ClientStore.ClientStore, yield* ClientStore.makeMemory),
    Effect.provideService(Transport.ClientTransport, yield* Transport.makeInMemory(handler, "g1"))
  );
  yield* engine.subscribe(Subset.make({ collection: "todos", where: Predicate.eq("done", false) }));
  yield* engine.mutate("todo/set", { id: "1", title: "ship it", done: false });
  yield* engine.push;
  yield* engine.pull;
  return yield* engine.query(Subset.make({ collection: "todos" }));
});
```

## Examples

Runnable apps driving the engine from different UI stacks. Each shows the same
core flow — optimistic writes, live views, push/pull/rebase against an
in-process demo backend. The web examples run the **real library server pipeline
in the page** (`SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`)
over a durable `localStorage` client store.

Three apps of increasing scope, each on React and Svelte:

| App                     | React                                         | Svelte                                          | Exercises                                                                                              |
| ----------------------- | --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Todo**                | [`react-todo`](examples/react-todo)           | [`svelte-todo`](examples/svelte-todo)           | One collection: optimistic writes, live views, durable journal + true offline, poke-driven convergence |
| **RealWorld** (Conduit) | [`react-realworld`](examples/react-realworld) | [`svelte-realworld`](examples/svelte-realworld) | Five collections joined over the mirror, relationships, server-side write authorization via identity   |
| **Northwind** (admin)   | [`react-northwind`](examples/react-northwind) | [`svelte-northwind`](examples/svelte-northwind) | Seven collections, relational joins, read-merge mutators, search/filter/pagination                     |

The React examples use the [`@legation/react`](packages/react) bindings
(`useQuery` / `useMutation`); the Svelte examples use
[`@legation/svelte`](packages/svelte) (`query` stores + `getMutate`).

Every example also wires up **spec export** (`SpecExport`, ADR-0017): run
`bun run spec` inside an example to project its sync surface — collections,
mutators — into `spec/openapi.json` (OpenAPI 3.1) and `spec/asyncapi.json`
(AsyncAPI 3.0), ready to feed a client generator. The documents are specialized
with the example's own row and mutator schemas, so a generated client gets
concrete per-name types rather than an opaque envelope.

Other UI stacks:

| Example                                 | Stack                                | Highlights                                                                                        |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`foldkit-todo`](examples/foldkit-todo) | [FoldKit](https://foldkit.dev) (web) | The todo app consuming `@legation/effect` directly (no framework bindings) — The Elm Architecture |

## Development

```bash
bun ci                  # install
bun run build           # build all packages (tsc project references)
bun run typecheck       # typecheck all packages + tests
bun run test:run        # run all tests
bun run lint            # oxlint
bun run format:check    # prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

MIT
