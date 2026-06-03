# @thomasfosterau/effect-sync-browser

Browser-runtime adapters for the [Effect](https://effect.website)-native sync engine in
[`@thomasfosterau/effect-sync-core`](../core). These modules implement core's
`ClientTransport` and `CacheStore` interfaces against browser platform globals:

- **`WebSocketTransport`** — a `ClientTransport` over the platform `WebSocket`, built on
  Effect's own `Socket` abstraction (`effect/unstable/socket`), with transparent
  auto-reconnect and exponential backoff. It also runs in Node 22+, which ships a global
  `WebSocket` client.
- **`IndexedDbCacheStore`** — a persistent `CacheStore` over `indexedDB`, so cached data
  survives page reloads.

Per [ADR-0006](../../docs/adr/0006-dependency-based-package-boundaries.md), all code that
depends on browser-only runtime globals (`WebSocket`, `indexedDB`) lives here rather than in
core, which must run identically in browsers, workers, edge runtimes, and Node.

## Install

```sh
bun add @thomasfosterau/effect-sync-browser @thomasfosterau/effect-sync-core effect
```

## WebSocket transport

`WebSocketTransport.layer` provides core's `ClientTransport` service, which the sync client
consumes. Each WebSocket text frame carries exactly one JSON-encoded protocol message
(`JSON.stringify` going up; incoming frames are schema-validated by core's
`ProtocolSchema.parseServerMessage` coming down) — the same framing the Node server runtime
speaks. Frames that fail schema validation are logged and skipped rather than tearing the
socket down.

```ts
import { Effect, Layer } from "effect";
import { SyncClient } from "@thomasfosterau/effect-sync-core";
import { WebSocketTransport } from "@thomasfosterau/effect-sync-browser";

const TransportLayer = WebSocketTransport.layer({
  url: "wss://sync.example.com",
  // reconnect is on by default; tune the backoff if you like:
  reconnectBaseDelay: "250 millis",
  reconnectMaxDelay: "10 seconds",
});

// Wire it into core's SyncClient (which depends on ClientTransport):
const AppLayer = SyncClient.layer.pipe(Layer.provide(TransportLayer));
```

The transport exposes `status` / `statusChanges` (`"connecting" | "connected" |
"disconnected"`) and an unbounded `messages` stream of incoming `ServerMessage`s. `send`
fails with a `TransportError` if called while the socket is not open (messages are **not**
buffered). The connection loop and socket are owned by the layer's scope and torn down when
the layer is released.

You can build a transport directly (scoped) instead of using the layer:

```ts
import { Effect } from "effect";
import { WebSocketTransport } from "@thomasfosterau/effect-sync-browser";

const program = Effect.scoped(
  Effect.gen(function* () {
    const transport = yield* WebSocketTransport.make({ url: "wss://sync.example.com" });
    yield* transport.send({ _tag: "Ping", id: "1" });
  })
);
```

For tests or non-global environments, pass a `webSocketConstructor`:

```ts
WebSocketTransport.make({ url, webSocketConstructor: (u) => new MyWebSocket(u) });
```

## IndexedDB persistence

`IndexedDbCacheStore.layer` provides core's `CacheStore` service backed by IndexedDB. It is a
thin composition of [`@effect/platform-browser`](https://www.npmjs.com/package/@effect/platform-browser)'s
`BrowserKeyValueStore.layerIndexedDb` (the official IndexedDB `KeyValueStore`) and core's
`KeyValueStoreAdapter` (which bridges any `KeyValueStore` into a sync-engine `CacheStore`).

Provide it wherever core expects a `CacheStore` (e.g. under the `SyncCache` layer):

```ts
import { Layer } from "effect";
import { SyncCache } from "@thomasfosterau/effect-sync-core";
import { IndexedDbCacheStore } from "@thomasfosterau/effect-sync-browser";

const CacheLayer = SyncCache.layer.pipe(
  Layer.provideMerge(
    IndexedDbCacheStore.layer({
      databaseName: "my-app-cache", // default: "effect-sync-cache"
    })
  )
);
```

The IndexedDB primitives default to `window.indexedDB`. In environments without a `window`
(tests, exotic workers), inject them explicitly:

```ts
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";

IndexedDbCacheStore.layer({
  databaseName: "test-cache",
  indexedDb: IndexedDb.make({ indexedDB, IDBKeyRange }),
});
```

Entries are JSON-serialized and schema-validated on read (core `KeyValueStoreAdapter`
semantics): corrupted entries are treated as cache misses. `entries(filter)` scans via a
maintained key index (**O(n)**), since IndexedDB cannot index hierarchical sync keys.

## License

MIT
