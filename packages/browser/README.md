# @legation/browser

Browser-runtime adapters for the [Effect](https://effect.website)-native sync engine in
[`@legation/effect`](../core). These modules implement core's
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
bun add @legation/browser @legation/effect effect
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
import { SyncClient } from "@legation/effect";
import { WebSocketTransport } from "@legation/browser";

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
import { WebSocketTransport } from "@legation/browser";

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

## `ElectedHost`: leader election for the no-service-worker topology

`ServiceWorkerHost.run` is the recommended deployment (the engine lives in
the per-origin service worker; every tab just mirrors it). Apps that can't
run a service worker instead run `ElectedHost.run`, which elects exactly one
tab per browser profile to host the engine on its main thread, via the [Web
Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)
(`navigator.locks`):

```ts
import { Effect, Layer } from "effect";
import { ClientStore, Transport } from "@legation/effect";
import { ElectedHost, IndexedDbClientStore } from "@legation/browser";
import { nodes, mutators } from "./domain.js";

const dependencies = Layer.mergeAll(
  IndexedDbClientStore.layerWindow(),
  Layer.effect(Transport.ClientTransport)()
  /* build a ClientTransport, e.g. RpcTransport.fromOrigin(...) */
);

const program = Effect.gen(function* () {
  const { client, role } = yield* ElectedHost.run({
    clientGroupId: "my-app", // the Web Lock name AND the sync client group
    nodes,
    mutations: mutators,
    dependencies,
  });
  // `client` works unchanged whether this tab is currently hosting or
  // mirroring; `role` (Stream<"host" | "mirror">) is for devtools/debug UI
  // only — never branch application logic on it.
});
```

The lock is held for the tab's whole lifetime once won (no voluntary
step-down). While waiting, this tab mirrors whichever tab currently holds
it, over the same `BroadcastChannel` `ServiceWorkerHost` uses. When the
elected tab closes or crashes, the browser grants the lock to the next tab,
which boots the engine against the SAME durable store — same journal, same
rows, same cookie — so the CVR conversation resumes rather than starting
over, and any mutation the old leader had already journaled survives and is
pushed by the new one. A mutation still in flight when the leader dies
either completes normally or fails visibly to its caller; it is never
silently dropped.

`examples/commerce` runs the service worker by default but wires this
topology in too, behind a documented dev-mode toggle (`?host=main` — see
`src/lib/host.ts`'s `bootElected` and `src/routes/+layout.svelte`), so the
no-service-worker fallback runs against a real app rather than only under
this package's own tests.

Environments without `navigator.locks` (some embedded webviews) get a
**documented fallback, not a polyfill**: `ElectedHost.run` logs a warning
and becomes the host immediately, which is only correct if exactly one tab
is ever open for that client group.

## IndexedDB persistence

`IndexedDbCacheStore.layer` provides core's `CacheStore` service backed by IndexedDB. It is a
thin composition of [`@effect/platform-browser`](https://www.npmjs.com/package/@effect/platform-browser)'s
`BrowserKeyValueStore.layerIndexedDb` (the official IndexedDB `KeyValueStore`) and core's
`KeyValueStoreAdapter` (which bridges any `KeyValueStore` into a sync-engine `CacheStore`).

Provide it wherever core expects a `CacheStore` (e.g. under the `SyncCache` layer):

```ts
import { Layer } from "effect";
import { SyncCache } from "@legation/effect";
import { IndexedDbCacheStore } from "@legation/browser";

const CacheLayer = SyncCache.layer.pipe(
  Layer.provideMerge(
    IndexedDbCacheStore.layer({
      databaseName: "my-app-cache", // default: "legation-cache"
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
