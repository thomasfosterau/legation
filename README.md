# effect-sync

A data synchronization engine built on [Effect](https://effect.website), shipped as a monorepo of composable packages: a protocol-agnostic core, a TanStack-Query-style client, a write-through cache engine for service workers and edge runtimes, a server-side sync hub with client fan-out, and a JSON:API adapter.

## Status

All packages target **Effect v4 beta** and ESM-only consumers. APIs are pre-1.0 and may change.

## Packages

| Package                                                   | Description                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-sync-core`](packages/core)       | Protocol-agnostic primitives: sync keys, cache store + write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, durable outbox, client/server sync protocol, transports, conflict resolution, and a promise facade for non-Effect consumers |
| [`@thomasfosterau/effect-sync-client`](packages/client)   | Client-side query/mutation/subscription manager (TanStack-Query-like) with live server subscriptions and offline outbox draining                                                                                                                                                                                                            |
| [`@thomasfosterau/effect-sync-cache`](packages/cache)     | Write-through cache engine for service workers, edge runtimes, and servers — HTTP caching and paginated queries, with pluggable persistence                                                                                                                                                                                                 |
| [`@thomasfosterau/effect-sync-server`](packages/server)   | Server-side write-through sync engine: versioned store, session registry, and fan-out of updates to subscribed clients                                                                                                                                                                                                                      |
| [`@thomasfosterau/effect-sync-jsonapi`](packages/jsonapi) | JSON:API v1.1 protocol adapter (formerly `@thomasfosterau/effect-chancery`)                                                                                                                                                                                                                                                                 |

## Architecture

```
            ┌────────────────────────────┐
            │   effect-sync-client       │  browser / app
            │  (queries, mutations,      │
            │   subscriptions, outbox)   │
            └─────────────┬──────────────┘
                          │ sync protocol over a Transport
            ┌─────────────▼──────────────┐
            │   effect-sync-server       │  your backend
            │  (sync hub, versioned      │
            │   store, fan-out)          │
            └─────────────┬──────────────┘
                          │
   ┌──────────────────────┴───────────────────────┐
   │              effect-sync-core                │
   │  keys · cache engine · queries · mutations   │
   │  outbox · protocol · transports · conflicts  │
   └──────────────────────┬───────────────────────┘
                          │
            ┌─────────────▼──────────────┐
            │   effect-sync-cache        │  service workers / edge
            │  (write-through HTTP and   │
            │   data caching)            │
            └────────────────────────────┘

   effect-sync-jsonapi: adapts JSON:API APIs into core query/mutation descriptors
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

Every package ships a promise facade so plain TypeScript apps, UI frameworks, and service workers can drive the engine without writing Effect code. See each package's README.

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
