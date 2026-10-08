# @thomasfosterau/legation-browser

Browser-runtime adapters for the legation engine: a service-worker engine host, an elected main-thread host, an IndexedDB client store, tab mirrors over BroadcastChannel, a Cache API HTTP cache, and Background Sync.

Code that depends on browser globals (`WebSocket`, `indexedDB`, `BroadcastChannel`, `navigator`) lives here, not in [`@thomasfosterau/legation-effect`](../effect), so the core runs the same in browsers, workers, edge runtimes and Node ([ADR-0006](../../docs/adr/0006-dependency-based-package-boundaries.md)).

The recommended topology runs the engine in the per-origin service worker, and every tab mirrors it ([ADR-0010](../../docs/adr/0010-service-worker-hosted-client-engine.md)). Apps that cannot run a service worker run the same host on a tab's main thread, elected once per `clientGroupId` (see [ElectedHost](#electedhost)). Either way one engine per client group owns the durable store, and every other tab is a mirror.

## Install

```sh
npm install @thomasfosterau/legation-browser @thomasfosterau/legation-effect effect @effect/platform-browser
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. `@effect/platform-browser` is peered with the same floor. Tested against `4.0.2` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR). Install one copy of `effect` in your app: two copies break `Context` identity.

## Usage

The shared domain, imported by the tab, the service worker and the server:

```ts
// domain.ts
import { Schema } from "effect";
import { Mutation, Node, type Query } from "@thomasfosterau/legation-effect";

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
const { id: _id, ...attributes } = Todo.fields;

export const nodes = Node.registry([
  Node.make("todos", { attributes, filterable: { done: ["eq"] } }),
]);

export const setTodo = Mutation.make("todo/set", Todo);
export const mutations = Mutation.registry([
  { mutator: setTodo, local: (todo, writer) => writer.put("todos", todo.id, todo) },
]);

export const openTodos: Query.Read = { collection: "todos", where: { done: false } };
```

A tab holds no engine. It mirrors the one the service worker serves, over the `legation` BroadcastChannel:

```ts
// page.ts
import { Client } from "@thomasfosterau/legation-effect";
import { BroadcastMirrorChannel } from "@thomasfosterau/legation-browser";
import { Effect, Stream } from "effect";
import { mutations, nodes, openTodos } from "./domain.js";

const program = Effect.gen(function* () {
  const channel = yield* BroadcastMirrorChannel.make("legation");
  const client = yield* Client.connect({ channel, nodes, mutations });
  yield* client.subscribe(openTodos);
  yield* client.mutate("todo/set", { id: "1", title: "Buy milk", done: false });
  yield* client
    .observe(openTodos)
    .pipe(Stream.runForEach((rows) => Effect.sync(() => console.log(`${rows.length} open`))));
});

Effect.runFork(Effect.scoped(program));
```

The service worker runs the engine. It is built from the same domain, over IndexedDB and the standard remote transport:

```ts
// service-worker.ts
import { Effect, Layer } from "effect";
import { IndexedDb } from "@effect/platform-browser";
import { Transport } from "@thomasfosterau/legation-effect";
import { ClientEngine, RpcTransport } from "@thomasfosterau/legation-effect/internal";
import {
  BackgroundSync,
  BrowserConnectivity,
  IndexedDbClientStore,
  ServiceWorkerHost,
} from "@thomasfosterau/legation-browser";
import { mutations, nodes } from "./domain.js";

const clientGroupId = "todo-group";

// 1. Top level, and synchronous: a worker woken for a `sync` event dispatches
//    it straight after evaluating this script, so the listener must exist now.
//    An app with sign-in passes an Effect that resolves its user's fingerprint.
const backgroundSync = BackgroundSync.listen({ identity: BackgroundSync.identityUnchecked });

// 2. The durable store. A worker has no `window`, so IndexedDB comes from the
//    worker's own globals.
const indexedDb = Layer.succeed(IndexedDb.IndexedDb)(IndexedDb.make({ indexedDB, IDBKeyRange }));
const storeLayer = IndexedDbClientStore.layer({ database: "todo-sw" }).pipe(
  Layer.provide(indexedDb)
);

// 3. The carrier: the standard remote transport (WebSocket, HTTP fallback),
//    wrapped with browser connectivity signals.
const transportLayer = Layer.effect(Transport.ClientTransport)(
  RpcTransport.fromOrigin({ clientGroupId, origin: "https://sync.example.com" }).pipe(
    Effect.flatMap(BrowserConnectivity.withBrowserConnectivity)
  )
);

// 4. The engine, then the host that serves the tabs from it.
const engineLayer = ClientEngine.layer({
  clientId: `sw-${clientGroupId}`,
  clientGroupId,
  mutators: mutations,
  syncLoop: { pullInterval: "15 seconds", pushDebounce: "300 millis" },
}).pipe(Layer.provide(Layer.merge(storeLayer, transportLayer)));

Effect.runFork(
  ServiceWorkerHost.run({ registry: nodes.collections, backgroundSync }).pipe(
    Effect.provide(engineLayer),
    Effect.scoped
  )
);
```

The tab's `BroadcastMirrorChannel` name and the host's default channel name are both `legation`, so the two find each other. The host keeps running until its scope closes.

## API

### Modules

| Module                   | What it is                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceWorkerHost`      | `run` and `start`: the recommended host. It serves the engine to the tabs from a service worker, and `start` also returns what a JSON:API façade needs.                     |
| `ElectedHost`            | `run`: elects one tab per client group, with `navigator.locks`, to host the engine on its main thread. The other tabs mirror it.                                            |
| `IndexedDbClientStore`   | The durable `ClientStore` over IndexedDB: `layer` (needs an `IndexedDb` service), `layerWindow` (the page's `indexedDB`) and `layerNamespaced` (one replica per identity).  |
| `BroadcastMirrorChannel` | `make(name)`: the mirror seam over a named `BroadcastChannel`. The mirror types (`EngineHost`, `MirrorChannel`, `MirrorProtocol`, `Mirror`) are also re-exported from here. |
| `CacheApiHttpCache`      | `open` and `fetchHandler`: a `ResponseCacheStore` over the Cache API, with stale-while-revalidate.                                                                          |
| `HttpCacheInvalidation`  | `collectionChanges` and `invalidateOnChanges`: evict cached responses as collections change, by the `collection:{name}` tag.                                                |
| `BrowserConnectivity`    | `withBrowserConnectivity(transport)`: adds `navigator.onLine` and return-to-visible signals to a `ClientTransport`.                                                         |
| `BackgroundSync`         | `listen`, `register` and `identityUnchecked`: flush the journal after the tab has closed.                                                                                   |

### ServiceWorkerHost

`ServiceWorkerHost.run(options)` serves mirrors and runs the engine's sync loop (pull on poke, push and pull on reconnect). It never returns, so keep its scope open. The options are `channelName` (default `"legation"`), `registry` (the collection registry the mirrors' related reads resolve against: pass `nodes.collections` whenever a tab uses `include`), `nodes` and `urls` (for a page that pins a URL), and `backgroundSync`.

The engine comes from the context, which is why the example builds it with `ClientEngine.layer` from the `internal` entry point. `ServiceWorkerHost.start(options)` does the same and returns a `Host`: the `engine`, and `registrations`, the subscriptions the host holds for its tabs. A worker that also serves JSON:API `GET`s from the replica (the façade, [ADR-0029](../../docs/adr/0029-replica-served-jsonapi-facade.md), `JsonApiFacade` in `@thomasfosterau/legation-jsonapi`) builds its coverage check from those registrations. The [`commerce` example](../../examples/commerce) runs this end to end, with its façade.

### BackgroundSync

A tab's journal flushes on reconnect and on return-to-visible, but only while a page is open. `BackgroundSync` covers the rest. The browser wakes the service worker with a `sync` event once connectivity returns, tab or no tab, and the host flushes the journal through `ClientEngine.push`.

- **Call `BackgroundSync.listen` at the top level of the worker script.** It holds a `sync` event open for `readyTimeout` (30 seconds by default) until a host attaches, so the host must boot without a tab. The service worker example does that.
- **`identity` is required.** It is an Effect that resolves who is signed in now, or `BackgroundSync.identityUnchecked` for an app with no sign-in, which accepts that a store still stamped for a signed-out user would be pushed. A flush pushes only if the store is stamped for that identity, and otherwise skips with `"IdentityChanged"` and leaves the journal for the next page to reset or upgrade. A tab that closed before `Client.reset` ran would otherwise leave the old identity's journal pushable.
- **Registration happens only when the journal cannot drain now:** a mutation journaled while the worker is offline, or a push that failed terminally. Online, the sync loop drains the journal as usual, and a registration would bypass `pushDebounce`.
- **A page can register too.** `BackgroundSync.register()` returns `"Registered"`, `"Unsupported"` or `"Refused"`, never fails, and is best-effort.
- **Two limits of registration from the worker.** Chromium refuses a registration made from a worker while no window of the origin is open, so a push that fails terminally after the last tab has closed registers nothing, and the journal waits for the next page. A page that wants to cover that case can call `BackgroundSync.register()` on `pagehide` (or `visibilitychange` to hidden) while it knows writes are pending. And on reconnect with a page open, both the sync loop and the `sync` flush push: the backend's ledger skips the duplicate, so the cost is one extra round trip, not a double write.
- **No retry ladder.** A flush that fails on the transport rejects the event's `waitUntil` promise, which is the browser's cue to reschedule it with its own backoff. The journal is untouched either way, and the next connectivity signal flushes it regardless.
- **Background Sync is Chromium-only.** On Safari and Firefox `register` returns `"Unsupported"`, and the journal flushes on the next connectivity signal when a page is open.
- **A foreign tag's event is left alone.** The listener answers only `BackgroundSync.defaultTag` (`"legation-flush"`) or the `tag` it was given.

Periodic Background Sync is not wrapped: it has its own permission story and battery cost. A worker that wants one can call `ClientEngine.pull` from its own `periodicsync` listener.

### ElectedHost

For apps without a service worker. `ElectedHost.run` elects exactly one tab per `clientGroupId` to host the engine on its main thread, through the Web Locks API (`navigator.locks`). The other tabs mirror that tab over the same BroadcastChannel. The lock is held for the tab's lifetime once won, so there is no voluntary step-down. When the elected tab closes or crashes, the next tab boots the engine against the same durable store. Its journal, rows and cookie carry over, so the CVR conversation resumes.

```ts
// elected.ts
import { ClientStore, Transport } from "@thomasfosterau/legation-effect";
import { RpcTransport } from "@thomasfosterau/legation-effect/internal";
import {
  BrowserConnectivity,
  ElectedHost,
  IndexedDbClientStore,
} from "@thomasfosterau/legation-browser";
import { Effect, Layer, Stream } from "effect";
import { mutations, nodes, openTodos } from "./domain.js";

const clientGroupId = "todo-group";

// Only built once this tab wins the election: nothing connects, and nothing
// opens IndexedDB, in a tab that is still mirroring.
const dependencies: Layer.Layer<ClientStore.ClientStore | Transport.ClientTransport> =
  Layer.mergeAll(
    IndexedDbClientStore.layerWindow({ database: "todo-app" }),
    Layer.effect(Transport.ClientTransport)(
      RpcTransport.fromOrigin({ clientGroupId, origin: "https://sync.example.com" }).pipe(
        Effect.flatMap(BrowserConnectivity.withBrowserConnectivity)
      )
    )
  );

const program = Effect.gen(function* () {
  const { client, role } = yield* ElectedHost.run({
    clientGroupId,
    nodes,
    mutations,
    dependencies,
  });
  // `role` is for devtools and debug UI only. Never branch app logic on it.
  yield* Effect.forkScoped(
    role.pipe(Stream.runForEach((current) => Effect.sync(() => console.debug("role", current))))
  );
  // `client` works the same whether this tab is hosting or mirroring.
  yield* client.subscribe(openTodos);
  yield* client
    .observe(openTodos)
    .pipe(Stream.runForEach((rows) => Effect.sync(() => console.log(`${rows.length} open`))));
});

Effect.runFork(Effect.scoped(program));
```

`ElectedHost.run` returns one `Client` for the tab's lifetime: reads and writes go through the mirror until this tab is elected, and through the engine from then on. Live `observe` streams re-subscribe on the switch, and `subscribe` pins are replayed. The lock name is `clientGroupId`, and the host's sync-protocol identity defaults to `host-${clientGroupId}`, so whichever tab wins resumes the same journal. Without `navigator.locks` (some embedded webviews), `ElectedHost.run` logs a warning and becomes the host at once. That is correct only when a single tab is ever open.

### IndexedDbClientStore

A durable `ClientStore` over IndexedDB. Every engine state transition lands in IndexedDB, so a killed service worker, or a closed tab in main-thread hosting, rehydrates without loss. The options are `database` (the IndexedDB database name), `prefix` (the key namespace, default `"legation/"`) and `identity`.

```ts
// idb.ts
import type { Identity } from "@thomasfosterau/legation-effect";
import { IndexedDbClientStore } from "@thomasfosterau/legation-browser";

// One replica for whoever is signed in. A sign-in change resets it, and the
// unpushed journal is quarantined under the old identity, never discarded.
export const sharedReplica = (fingerprint: Identity.Fingerprint) =>
  IndexedDbClientStore.layerWindow({ database: "todo-app", identity: fingerprint });

// One replica per identity, keyed by fingerprint. Switching back finds the replica warm.
export const perUserReplica = (fingerprint: Identity.Fingerprint) =>
  IndexedDbClientStore.layerNamespaced(fingerprint, { database: "todo-app" });
```

Choose by how sign-ins behave on the device. Namespace when a few regular users switch back and forth, since each keeps a warm replica on disk. Reset when sign-ins are one-off or unbounded, such as a kiosk or a shared library machine, where a replica per visitor is the worse trade. Layers that take an `identity` (`layer`, `layerWindow`) turn the identity boundary on. `layerWindow` expects the page's own `indexedDB`. In a worker, provide `IndexedDb` yourself, as the service worker example does.

### HTTP cache

`CacheApiHttpCache` keeps responses in a named Cache API cache, and its `fetchHandler` serves them stale-while-revalidate under a per-request policy. A policy returning `undefined` bypasses the cache. `HttpCacheInvalidation` evicts entries by tag as the engine's collections change: a response tagged `collection:todos` is dropped when `todos` changes.

```ts
// cache.ts
import type { ClientEngine, HttpCache } from "@thomasfosterau/legation-effect/internal";
import { CacheApiHttpCache, HttpCacheInvalidation } from "@thomasfosterau/legation-browser";
import { Effect } from "effect";

const policy = (request: Request): HttpCache.HttpCachePolicy | undefined =>
  request.mode === "navigate"
    ? { tags: ["pages"], staleTime: "5 seconds", timeToLive: "1 hour" }
    : undefined;

// Answer a request from the cache, or from the network when nothing is cached.
export const respond = (request: Request) =>
  Effect.gen(function* () {
    const store = yield* CacheApiHttpCache.open("app-cache");
    const handle = CacheApiHttpCache.fetchHandler({ store, policy });
    const result = yield* handle(request);
    return result.response;
  });

// Evict cached responses as the engine's collections change. Run it in a scope.
export const evictOnChanges = (engine: ClientEngine.ClientEngine) =>
  Effect.gen(function* () {
    const store = yield* CacheApiHttpCache.open("app-cache");
    yield* HttpCacheInvalidation.invalidateOnChanges({
      store,
      changes: HttpCacheInvalidation.collectionChanges(engine.engineEvents),
    });
  });
```

`fetchHandler` returns `revalidate` for a stale response. A service worker passes it to `event.waitUntil` so the refresh finishes after the response is sent.

### BrowserConnectivity

`BrowserConnectivity.withBrowserConnectivity(transport)` wraps a `ClientTransport` so its status combines `navigator.onLine` with the transport's own signal. A return to the visible tab counts as a poke, so the sync loop catches up. The service worker and elected host examples above both use it. It is scoped: its listeners are removed when the scope closes.

### BroadcastMirrorChannel

`BroadcastMirrorChannel.make(name)` opens a `BroadcastChannel` as the mirror seam's `MirrorChannel`, and closes it with its scope. A tab passes it to `Client.connect`, as the tab example does. Its name must match the host's `channelName`, which defaults to `"legation"`.

## License

MIT
