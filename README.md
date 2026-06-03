# effect-sync

A data synchronization engine built on [Effect](https://effect.website): write-through caching, a TanStack-Query-style client, a cache engine for service workers and edge runtimes, and a server-side sync hub with client fan-out — all in one Effect-native core package, plus protocol adapters.

## Status

All packages target **Effect v4 beta** and ESM-only consumers. APIs are pre-1.0 and may change.

## Packages

Package boundaries are drawn by dependency footprint ([ADR-0006](docs/adr/0006-dependency-based-package-boundaries.md)): everything that needs only `effect` lives in core; protocol- or framework-specific code gets its own package.

| Package                                                   | Description                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-sync-core`](packages/core)       | The sync engine: keys, cache stores, write-through cache engine, queries, pagination, mutations, offline outbox, sync protocol, transports, conflict resolution, the client query/mutation/subscription manager, the service-worker/edge HTTP cache, the server-side sync hub with fan-out, and promise facades for non-Effect consumers |
| [`@thomasfosterau/effect-sync-jsonapi`](packages/jsonapi) | JSON:API v1.1 protocol adapter (formerly `@thomasfosterau/effect-chancery`)                                                                                                                                                                                                                                                              |

## Architecture

```
   browser / app                  your backend
┌─────────────────────┐        ┌─────────────────────┐
│ QueryClient         │        │ SyncHub             │
│ SyncClient (offline)│◀──────▶│ ServerStore         │
│ ClientFacade        │  sync  │ Sessions (fan-out)  │
├─────────────────────┤protocol├─────────────────────┤
│                     │ over a │                     │
│  service worker /   │Transport                     │
│  edge runtime       │        │                     │
│ WriteThroughCache   │        │                     │
│ HttpCache           │        │                     │
├─────────────────────┴────────┴─────────────────────┤
│              effect-sync-core primitives           │
│   SyncKey · SyncCache · Query · Mutation · Outbox  │
│      Protocol · Transport · Versioned · Facades    │
└─────────────────────────────────────────────────────┘
          ▲
          │ descriptors
┌─────────┴───────────┐
│ effect-sync-jsonapi │  JSON:API adapter
└─────────────────────┘
```

Every piece is an Effect service with a Layer, so everything is swappable: storage backends, transports, conflict strategies, and stores are all interfaces with in-memory implementations provided for tests and development.

## Quick start

### Client-side caching and queries

```ts
import { Duration, Effect, Layer } from "effect";
import { MemoryCacheStore, SyncCache } from "@thomasfosterau/effect-sync-core";

const layer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const program = Effect.gen(function* () {
  const cache = yield* SyncCache.SyncCache;
  return yield* cache.read({
    key: ["users", "1"],
    loader: fetchUser("1"), // any Effect
    staleTime: Duration.minutes(5),
  });
});

await Effect.runPromise(program.pipe(Effect.provide(layer)));
```

### Non-Effect consumers

The core package ships promise facades (`ClientFacade`, `ServerFacade`, `PromiseFacade`) so plain TypeScript apps, UI frameworks, and service workers can drive the engine without writing Effect code. See the [core README](packages/core/README.md).

## Development

```bash
bun ci                  # install
bun run build           # build all packages (tsc project references)
bun run typecheck       # typecheck all packages + tests
bun run test:run        # run all tests
bun run lint            # oxlint
bun run format:check    # prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, [CONTEXT.md](CONTEXT.md) for the domain glossary, and [docs/adr/](docs/adr/) for architecture decisions.

## License

MIT
