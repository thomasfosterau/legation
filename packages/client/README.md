# @thomasfosterau/effect-sync-client

A TanStack-Query-style **client sync engine** built on [Effect](https://effect.website),
layered on top of [`@thomasfosterau/effect-sync-core`](../core).

It turns declarative query and mutation descriptors into:

- **Observable queries** — a `Stream` of query state that emits loading,
  then the loaded value, then keeps emitting as the underlying cache entry
  changes (server pushes, invalidations, removals).
- **Optimistic mutations** — apply patches locally, roll back on failure,
  invalidate dependent keys on success.
- **Live server subscriptions** — wire a `ClientTransport`'s server
  messages into the local cache so observed queries refresh automatically.
- **An offline outbox** — queue mutations while offline and push them when
  the connection returns.
- **A promise/callback facade** — for non-Effect consumers.

## Install

```sh
npm install @thomasfosterau/effect-sync-client @thomasfosterau/effect-sync-core effect
```

## Effect-native quick start

```ts
import { Effect, Layer, Stream } from "effect";
import { MemoryCacheStore, Query } from "@thomasfosterau/effect-sync-core";
import { QueryClient } from "@thomasfosterau/effect-sync-client";

// QueryClient.layer composes SyncCache.layer internally and only needs a
// CacheStore underneath it.
const layer = QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const program = Effect.gen(function* () {
  const client = yield* QueryClient.QueryClient;

  const userQuery = Query.make({
    key: ["users", "1"],
    loader: Effect.succeed({ id: "1", name: "Ada" }),
    staleTime: "5 minutes",
  });

  // Read-through fetch.
  const user = yield* client.fetch(userQuery);

  // Observe the query: loading -> success -> (live updates).
  const states = yield* Stream.runCollect(Stream.take(client.observe(userQuery), 2));

  return { user, states };
});

Effect.runPromise(program.pipe(Effect.provide(layer)));
```

### Offline sync engine

`SyncClient` combines the query client, an `Outbox`, and a `ClientTransport`:

```ts
import { SyncClient } from "@thomasfosterau/effect-sync-client";

const engine = Effect.gen(function* () {
  const client = yield* SyncClient.SyncClient;
  // Apply a mutation locally and enqueue it for delivery.
  yield* client.mutateLocal(createTodo, { title: "Buy milk" });
  // Run the background engine (streams server updates + pushes the outbox).
  yield* Effect.forkScoped(client.runSync);
});
```

## Promise facade quick start

For apps that are not written in Effect:

```ts
import { Facade } from "@thomasfosterau/effect-sync-client";

const client = Facade.makeClient({ maxEntries: 1000 });

const user = await client.fetch(["users", "1"], () => fetchUser("1"), {
  staleTimeMillis: 60_000,
});

const unsubscribe = client.subscribe(["users", "1"], () => fetchUser("1"), {
  onState: (state) => render(state),
});

await client.mutate(
  ["users", "1"],
  (input) => saveUser(input),
  { name: "Grace" },
  {
    invalidates: [["users"]],
  }
);

unsubscribe();
await client.dispose();
```

## License

MIT
