# @legation/browser

Browser-runtime adapters for the [Effect](https://effect.website)-native sync engine in
[`@legation/effect`](../core). These modules implement core's
`ClientTransport` and `CacheStore` interfaces against browser platform globals:

- **`WebSocketTransport`** — a `ClientTransport` over the platform `WebSocket`, built on
  Effect's own `Socket` abstraction (`effect/socket`), with transparent
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

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. `@effect/platform-browser` is peered with the same floor. Tested against `4.0.0-rc.118` (both the floor and the version CI pins); install one copy of `effect` in your app (ADR-0003).

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

## `ServiceWorkerHost.start`: what a worker's façade needs

`ServiceWorkerHost.run` serves mirrors and runs the sync loop forever.
`ServiceWorkerHost.start` does the same and returns the `Host` — the engine it
serves and `registrations`, the root windows and relational registrations the
host holds on its mirrors' behalf at that moment — listed once the engine
holds their windows, with the canonical URL of a `SubscribeUrl` while some
party still holds it by URL. That is the ledger a JSON:API façade (`JsonApiFacade` in
`@legation/jsonapi`, ADR-0029) consults in a worker, where no `Client`'s own
ledger sees the tabs' pins:

```ts
const host = yield * ServiceWorkerHost.start({ nodes, urls, registry });
const coverageOf = Coverage.coverageOf(nodes, host.registrations);
// ... build the façade over ClientView.fromEngine(host.engine) and coverageOf,
// then keep the scope open: yield* Effect.never
```

`EngineHost.run` itself now returns the same `Host`.

## `BackgroundSync`: a closed tab's writes still land

`BrowserConnectivity` flushes the journal on reconnect and on a return to the
tab — but only while a page is open. `BackgroundSync` covers the rest: the
browser wakes the service worker with a `sync` event once connectivity is
back, tab or no tab, and the host flushes the journal through the ordinary
`ClientEngine.push`.

```ts
// service-worker.ts — at the TOP LEVEL of the script, not inside an Effect:
// a worker woken for `sync` dispatches the event straight after evaluating
// the script, before any engine layer could have been built.
const backgroundSync = BackgroundSync.listen({
  // Required: who is signed in now, as the app knows it inside the worker
  // (an Effect resolving a fingerprint, or `undefined` for "cannot tell").
  // An app with no sign-in at all passes `BackgroundSync.identityUnchecked`.
  identity: currentFingerprint,
});

// ... once the engine's layers are built:
yield * ServiceWorkerHost.start({ backgroundSync, registry, nodes, urls });
```

- **Only the library's tag** (`BackgroundSync.defaultTag`, or `tag`) is
  answered. A worker receives every Background Sync registration on the
  origin, and a foreign tag's event is left untouched.
- **Registration happens only when the journal cannot drain now**: a mutation
  journaled while the worker is offline (`navigator.onLine === false`, or the
  `offline` option), or a push that failed terminally. Never on an online
  write: online, Chromium fires a fresh registration's `sync` almost at once,
  so registering every mutation would push each one on its own and bypass
  `pushDebounce` and paced compaction (#246). A page can also call
  `BackgroundSync.register()` itself when a write could not be sent.
- **Two limits of registration from the worker.** Chromium refuses a
  registration made from a worker while no window of the origin is open, so a
  push that fails terminally _after the last tab has closed_ registers
  nothing; the journal then waits for the next page. A page that wants to
  cover that case can call `BackgroundSync.register()` on `pagehide` (or
  `visibilitychange` to hidden) while it knows writes are pending. And on
  reconnect with a page open, both the sync loop and the `sync` flush push:
  the backend's ledger skips the duplicate, so the cost is one extra round
  trip, not a double write.
- **Absence is a working state.** Background Sync is Chromium-only; on Safari
  and Firefox `register` returns `"Unsupported"`, logs only at debug level,
  and the journal flushes on the next connectivity signal instead.
- **No retry ladder.** A transport failure rejects the event, which is the
  browser's cue to reschedule it; the journal is untouched either way.
- **The identity boundary holds** (#212). Quarantined entries are unreachable
  from `push`, so a `sync` event never sends a superseded identity's writes.
  That only covers a reset that ran, so `identity` is **required**: a flush
  skips (`"IdentityChanged"`) whenever the store is not stamped for whoever
  is signed in now — which catches a tab that closed before `Client.reset`.
  `BackgroundSync.identityUnchecked` opts out explicitly, and accepts that a
  store still stamped for a signed-out user would be pushed; it is only for
  apps with no sign-in.
- **The host must be able to boot without a tab.** The listener holds a `sync`
  event open for `readyTimeout` (30 seconds) waiting for a host; a worker that
  only starts its host on a page's handshake never attaches on a tab-less wake.

### Why delete a hand-rolled outbox for this

An outbox that replays raw HTTP requests has two defects that are properties
of the approach, not bugs in it. A send that succeeds but whose response is
lost is indistinguishable from a failure and gets retried, duplicating the
write — hence client-generated ids plus a re-fetch to prove a 409 was one's own
retry. And a 4xx has to be discarded, because retrying it forever would wedge
the queue, so the user's write silently vanishes. The journal has neither
problem: per-client mutation ids give exactly-once application from the
backend's ledger, and a refused write is a permanent rejection — acknowledged
and skipped so nothing behind it wedges, its optimistic effect dropped, and
the refusal kept in `mutationStates` with its reason.

Periodic Background Sync is not wrapped: it has its own permission story and
battery cost. A worker that wants a periodic pull can call `ClientEngine.pull`
from its own `periodicsync` listener.

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
