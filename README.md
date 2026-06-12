# effect-sync

A modular sync engine built on [Effect](https://effect.website): mutation-log writes with server-authoritative rebase, CVR-tracked state patches downstream, typed collections with live queries, offline-first clients, and a customisable transport seam — designed to integrate natively with Effect's RPC, HttpApi, reactivity, and persistence modules.

## Status

**v2 rebuild in progress** (see [ADRs 0007–0010](docs/adr/)). The end-to-end engine core — optimistic mutations → journal → push → authoritative backend → CVR diff → pull patch → rebase — works in-process today; transports, browser hosts, and bindings are landing in phases. All packages target **Effect v4 beta** and ESM-only consumers. APIs are pre-1.0 and will change.

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

See [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr/](docs/adr/) for the decisions.

## Packages

Package boundaries are drawn by dependency footprint ([ADR-0006](docs/adr/0006-dependency-based-package-boundaries.md)).

| Package                                                   | Description                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-sync-core`](packages/core)       | The engine: collections, predicates, mutators, journal, client engine with rebase, protocol, transport seam, BYO backend contract, CVR bookkeeping, auth, invalidation bus, sync rooms, HTTP cache interfaces |
| [`@thomasfosterau/effect-sync-browser`](packages/browser) | Browser adapters (phase 3): service-worker host, IndexedDB client store, tab mirrors, Cache API response store                                                                                                |
| [`@thomasfosterau/effect-sync-node`](packages/node)       | Node adapters (phase 2/3): serving the default RPC protocol, distributed bus adapters                                                                                                                         |
| [`@thomasfosterau/effect-sync-jsonapi`](packages/jsonapi) | JSON:API v1.1 helpers; being repositioned as collection loaders                                                                                                                                               |

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
} from "@thomasfosterau/effect-sync-core";

// 1. Shared mutator contract (client runs it optimistically; your backend
//    runs its own authoritative version).
const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args: any, writer) => writer.put("todos", args.id, args),
  },
]);

// 2. Server: reference in-memory backend + deny-by-default auth.
const server = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make({
    "todo/set": (args: any, writer) => Effect.asVoid(writer.put("todos", args.id, args)),
  });
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
