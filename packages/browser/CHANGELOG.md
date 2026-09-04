# @legation/browser

## 0.2.0

### Minor Changes

- a94df19: Bound every in-process message hub so a stalled or slow consumer can no longer
  grow a queue without limit (#44). Because pull is the correctness path, each hub
  sheds load under pressure without threatening convergence:
  - **Poke hub** (`Transport.makePokeHub`): now `sliding(1)` per client group with
    replay 1. A poke storm collapses to one queued poke per group — an outstanding
    poke absorbs the rest — and a late/reconnecting subscriber still sees the most
    recent poke.
  - **Invalidation bus** (`InvalidationBus.makeInProcess` and the memory broker):
    now bounded with a `dropping` strategy at a configurable capacity. A dropped
    hint only delays the next pull (ADR-0009); drops are counted in
    `legation_hints_dropped_total`. New `makeInProcessWith` / `layerInProcessWith`
    / `makeMemoryBrokerWith` take a `capacity` option.
  - **Engine change hub** (`ClientEngine`): now bounded `dropping` at a
    configurable capacity (`ClientEngineOptions.changeHubCapacity`, default 1024).
    Each view-change carries a monotonic sequence number; a consumer that sees a
    seq gap collapses it into a full `Rebuild` that subsumes the dropped `Patch`es,
    so the view stays correct under pressure and behaves identically under none.
    Collapses are counted in `legation_change_collapses_total`.
  - **Mirror change hub** (`TabMirror`): now bounded `dropping` at a configurable
    capacity (`TabMirrorOptions.changeHubCapacity`, default 1024). A seq gap makes
    the observer re-read its subset from the mirror's `Ref` (a full refresh,
    lossless because the `Ref` holds the latest rows), counted in
    `legation_mirror_refreshes_total`.

  A `Patch` is never silently dropped: it is only ever shed behind a seq gap that
  forces a `Rebuild` before the view is next read.

- 5496ddf: Bump the pinned Effect version from `4.0.0-beta.84` to `4.0.0-beta.107` across
  all packages (catalog and exact `peerDependencies`), and move
  `@legation/jsonapi` and the commerce example from
  `@thomasfosterau/effect-jsonapi@^0.6.0` to `^0.12.0` (#152).

  **Why beta.107.** effect-jsonapi 0.12 requires `effect >= 4.0.0-beta.104` and
  develops against `4.0.0-beta.107` exactly, so that is the version its typings
  are known to line up with. The later `4.0.0-rc.*` releases were not attempted
  in this change: the exact-pin policy (ADR-0003) prefers the version the
  adopted library is built against, and every `effect/unstable/*` module this
  repo uses (`httpapi`, `http`, `rpc`, `reactivity`, `persistence`, `sql`)
  compiles and tests clean on beta.107.

  **Effect API drift absorbed (no behavioural change):**
  - `Schedule.either` / `Schedule.both` are gone; the default retry policy is now
    `Schedule.max([Schedule.min([exponential, spaced]), recurs(5)])`, which is
    the same policy (`min` recurs while any schedule recurs at the shortest
    delay, `max` recurs while all recur at the longest delay).
  - `Schema.TaggedErrorClass` is now `Schema.TaggedError` (the wire
    `SyncRpcError` is unchanged on the wire).
  - `SchemaRepresentation.fromASTs` is now `SchemaRepresentation.toRepresentations`
    (spec export output is unchanged).
  - `HttpApiGroup.Any` is gone and `HttpApi`'s group parameter is now
    invariant, so `JsonApiSync.layer`, `JsonApiSync.inspect` and
    `Convention.reflectResources` are generic over the concrete `HttpApi`
    instead of accepting a widened alias. The exported `JsonApiSync.JsonApi`
    alias is now `HttpApi.Constraint` (identifier and groups erased); pass your
    concrete api to the functions rather than annotating it with the alias.

  **effect-jsonapi 0.6 → 0.12 at the ADR-0016 boundary.** `Document`, `Query`,
  `Resource`, `Relationship` and `Endpoint` lost no exports; `Query` gained
  `IncludeOption`/`IncludePathsOf`/`OffsetPageStruct`/`bracketPageKeys` and
  `Resource` gained `IncludeDepth`/`IncludePathsTo`. `schema.ts`, `types.ts` and
  `CollectionLoader.ts` compile unchanged. One typing regression was noticed in
  0.12: endpoints with `:id` params (`Endpoint.get`/`delete`/`update`) declare
  their params as `Schema.Struct<Schema.Struct.Fields & { id }>`, which leaks
  `unknown` into the requirements of the corresponding `HttpApiClient` calls.
  The commerce example narrows this with a small `run` helper in
  `server/client.ts`; nothing in the published packages is affected.

  The bump is `minor` rather than `patch` because the exact `effect` peer pin
  means every consumer must move `effect` in the same change, and the
  `@legation/jsonapi` type signatures above changed shape.

- 19eb4b0: Bump the pinned Effect version from `4.0.0-beta.65` to `4.0.0-beta.75` across all packages.

  `@legation/browser` now builds its IndexedDB cache store on
  `@effect/platform-browser` (`BrowserKeyValueStore.layerIndexedDb` + core's
  `KeyValueStoreAdapter`) instead of a hand-rolled IndexedDB wrapper.
  `@effect/platform-browser` is a new peer dependency of the browser package, and
  `IndexedDbCacheStore.make` is now a scoped resource (requires `Scope`); the
  `storeName` option was removed (the underlying object store is managed by
  platform-browser).

- 38c3147: Effect-idiomatic API refactor:
  - Protocol messages (`ClientMessage`, `ServerMessage`, `PushResult`, `WireKeyFilter`), cache
    events (`CacheEvent`), and outbox events (`OutboxEvent`) are now `Data.TaggedEnum`s with
    generated constructors, `$is` guards, and exhaustive `$match` matchers
    (e.g. `Protocol.ClientMessage.Subscribe({...})`). The types are structurally unchanged, so
    existing object-literal construction still compiles.
  - `SyncCacheDefaults` `Context.Reference` for ambient cache timing defaults
    (staleTime / timeToLive / staleWhileRevalidate).
  - The cache's in-flight dedupe map uses `MutableHashMap`; background stale-while-revalidate
    refresh failures are now logged instead of silently swallowed.
  - The WebSocket transports validate incoming frames with `ProtocolSchema` codecs instead of
    unchecked `JSON.parse` casts, and bridge socket events into Effect without `Effect.runFork`
    inside callbacks.
  - All tests use `@effect/vitest` (`it.effect` / `it.live` / `it.layer`, `TestClock`).

- 2003cd6: Built-in multi-tab leader election for the no-service-worker degraded
  topology (#119): `@legation/browser`'s `ElectedHost.run` wraps
  `navigator.locks` (held for the tab's whole lifetime, no voluntary
  step-down) around `ServiceWorkerHost.run`'s main-thread host composition —
  `ClientEngine` + durable store + transports + `BroadcastMirrorChannel`
  serving while elected, a `Client.connect` mirror over the same channel
  while not. It hands back one `Client` that keeps working unchanged across
  the mirror→host promotion (a switching `ClientView` swaps the underlying
  tier, replaying explicit subscriptions and re-hydrating live
  `observe`/`related` streams) and a `role: Stream<"host" | "mirror">` for
  devtools/debug UI. A promoted tab boots against the SAME durable store —
  same journal, rows, and cookie — so the CVR conversation resumes rather
  than restarting. Environments without `navigator.locks` get a documented
  fallback (becomes host immediately), not a polyfill.

  `@legation/effect`'s `Mirror` now fails any request still in flight when
  the host it was talking to is gone — either because the mirror's own scope
  closed, or because a second `HostReady` announces the host restarted — with
  a clear `TransportError` instead of leaving the caller's `mutate` /
  `mutateWithAck` / server-fallthrough `read` call hanging forever. A
  mutation already journaled by the old host before it died is never lost:
  it's durable in the shared store and the next host's sync loop picks it up
  regardless of what this caller was told.

- c105fbf: Drive HTTP-cache invalidation from collection changes (#49).
  - **`PullCompleted` enrichment** (`@legation/effect`): the `PullCompleted`
    `EngineEvent` now carries `collections` — the distinct collections the pulled
    patch touched (a `Clear` stands for every collection the client currently
    holds, since it resets the whole view). The field is always present. This lets
    a collection-scoped reaction fire even on a client with an empty journal (the
    common case, where a pull emits a `Patch` change and no `ViewRebuilt`).
  - **`HttpCacheInvalidation`** (`@legation/browser`): `invalidateOnChanges` forks
    a scoped fibre that evicts every cached response tagged for a changed
    collection via the store's `invalidateTags`; a store error is logged and
    swallowed, never fatal. `collectionChanges` derives the change feed from an
    engine's `engineEvents` (mapping `PullCompleted.collections` and scoped
    `ViewRebuilt.collections`, dropping empties). Wire it in a service worker by
    forking `invalidateOnChanges` alongside `ServiceWorkerHost.run` (recipe in the
    host's doc comment).

  The tag convention is `collection:{name}` (the default `tagFor`): a response
  tagged `collection:todos` is evicted whenever `todos` changes. This is a
  collection-level granularity ceiling — every response tagged for a changed
  collection is evicted; a per-row `collection:{name}:{id}` convention could
  follow once patch-op row ids are plumbed through to the change feed (not
  implemented here).

- 501b12c: The mirror seam sheds its browser-tab coupling: the party served by
  `EngineHost` is any client context — a browser tab, an Electron window,
  an extension, a CLI instance — so the vocabulary now says what the
  contract means. `TabMirror` is `Mirror` (module, namespace, and type),
  `tabId` is `mirrorId` (wire field included), `TabMessage` is
  `MirrorMessage` (`decodeTabMessage` → `decodeMirrorMessage`), the host's
  liveness option `tabTimeout` is `mirrorTimeout`, and
  `MirrorChannel.makeLoopbackPair` returns `{ host, mirror }`. Clean
  break, no aliases; `@legation/browser` re-exports the new names.
- 7f1efac: Named queries and auto-subscribing relational reads cross the mirror
  protocol (ADR-0021 follow-up). `ClientView` gains
  `subscribeQuery`/`unsubscribeQuery`/`queryNamed`/`observeNamed` and
  `related` — both hosts satisfy the widened seam (`ClientViewError` now
  includes `QueryError`). The tab↔host protocol adds
  `SubscribeNamed`/`UnsubscribeNamed` (the host engine owns the server
  round-trip) and `SubscribeRelated`/`UnsubscribeRelated`, where the host runs
  the reconcile loop AND the join and the tab receives resolved rows
  (`RelatedUpdate`) — data work stays off the main thread. `EngineHost` takes
  an optional `registry` for relational resolution and refcounts all
  registration kinds per tab. A new `HostReady` announcement makes
  registrations survive host restarts: a starting host broadcasts it and
  every mirror replays the registrations it holds — covering killed service
  workers and tabs that raced the worker's boot. On a mirror, observing IS
  subscribing: `TabMirror.observe`/`observeNamed`/`related` auto-register
  their subject with the host for the stream's lifetime through a per-key
  interest ledger (a mirror only carries keys some tab registered, and the
  host refcounts per tab, so the ledger posts `Subscribe` on first interest
  and `Unsubscribe` only when the last observer ends and no explicit
  `subscribe` pins the key). In `@legation/svelte`, `namedQuery`,
  `useNamedQuery`, and `useRelated({ subscribe: true })` now work over
  mirror-only runtimes (the internal engine-lookup fallback is removed).
- cf0b26c: The mirror seam moves to core, where ADR-0006's dependency rule places it:
  `MirrorProtocol`, the `MirrorChannel` interface + loopback pair,
  `EngineHost`, and `TabMirror` are exported from `@legation/effect` — none
  of them needs a browser global, so Electron windows, extensions, and CLI
  processes can host or consume mirrors without `@legation/browser`. The
  browser package keeps what is actually browser-coupled — the new
  `BroadcastMirrorChannel.make(name)` binding (formerly
  `MirrorChannel.makeBroadcastChannel`) and `ServiceWorkerHost` — and
  re-exports the moved modules for compatibility.
- f54f568: Per-mutation outcome surface (#36). Callers can now await a mutation's
  authoritative backend outcome — applied, or permanently rejected with a reason
  (#35) — rather than only its journal ack.
  - `ClientEngine.mutateWithAck` returns a `MutationHandle` whose `acknowledged`
    effect resolves with the `MutationOutcome` once the backend settles the
    mutation via a push or pull acknowledgement. `ClientEngine.mutationEvents`
    streams the lifecycle (`journaled`, then `acknowledged` or `rejected`). Plain
    `mutate`/`mutateEncoded` are unchanged and register no deferred; pending
    acknowledgements are interrupted on engine scope close, so they never hang.
  - Svelte gains `useMutationWithAck` (over an additive
    `EngineAtoms.mutationWithAck` atom), returning a promise of the outcome.
  - The tab mirror forwards the outcome: `MirrorProtocol` gains an additive
    `MutateSettled` host→tab message, `EngineHost` awaits the backend verdict on a
    scoped fibre and posts it, and `TabMirror.mutateWithAck` awaits it (the
    existing journal-ack `mutate` is unchanged).

- 9d2f21b: Rename the project to **Legation**. Every package moves to the `@legation`
  scope: the engine is now `@legation/effect` (formerly
  `@thomasfosterau/effect-sync-core`), and the adapters/bindings are
  `@legation/browser`, `@legation/node`, `@legation/jsonapi`, `@legation/sql`,
  and `@legation/svelte` (formerly `@thomasfosterau/effect-sync-*`).

  Runtime identifiers follow the brand, which is **breaking for persisted local
  state and dashboards**:
  - `Context.Service` identifiers: `@thomasfosterau/effect-sync-core/*` →
    `@legation/effect/*` (and per-package equivalents)
  - Client-store key prefix: `effect-sync/` → `legation/`; CVR store prefix:
    `effect-sync/cvr/` → `legation/cvr/`. Existing IndexedDB/KV state under the
    old prefix is orphaned — clients rehydrate via a full pull; export any
    pending journal before upgrading offline clients.
  - Metrics: `effect_sync_*` → `legation_*`; spans: `effect-sync.*` →
    `legation.*`
  - Default BroadcastChannel name: `effect-sync` → `legation`; Redis hint
    stream: `effect-sync:hints` → `legation:hints`; cache metadata header:
    `x-effect-sync-cache-meta` → `x-legation-cache-meta`

- c189ae7: Add runtime-specific adapter packages:
  - `@legation/browser` — WebSocket client transport (`ClientTransport` over the browser `WebSocket` global) and IndexedDB-backed `CacheStore` persistence for offline-first apps.
  - `@legation/node` — WebSocket server transport: accepts WebSocket connections (via `ws`) and exposes each as a `ServerConnection` ready to hand to the core `SyncHub`.

- 9a6426b: Sync-loop scheduling (#33). `ClientEngine` grows a configurable scheduler on
  `runSync`, driven by `Effect.Schedule` and the existing `statusChanges` seam:
  - `syncLoop.pushDebounce` auto-pushes after `mutate`/`mutateEncoded`, debounced
    so a burst of mutations coalesces into a single push.
  - `syncLoop.pullInterval` pulls periodically as the correctness backstop, so a
    client converges over pull alone even without pokes.
  - The baseline triggers (pull on poke, push+pull on reconnect) are retained,
    and every scheduling fibre is scoped — interrupted when the engine scope
    closes.

  `@legation/browser` adds `BrowserConnectivity.withBrowserConnectivity`, which
  layers `navigator.onLine` + `online`/`offline` + `visibilitychange` onto any
  `ClientTransport` so `statusChanges` becomes truthful for carriers (like the RPC
  transport) that otherwise report themselves permanently connected, and a
  return-to-visible surfaces a poke.

  `@legation/jsonapi` `JsonApiSync` now configures the core loop (`pullInterval`,
  `pushDebounce` options, 5-second default interval) instead of running its own
  `Effect.forever` poll; `JsonApiSync.start` just runs `runSync`.

- e34bc24: Connection-status realism at the transport seam: `Transport.withInferredStatus`
  derives real connectivity from observed push/pull behaviour ("connecting"
  until the first call settles, "connected" on success, "disconnected" on a
  `TransportError`) — wrapping the default RPC carrier, which reports itself
  permanently "connected". `Transport.withFallback(primary, fallback)` layers a
  fallback carrier (e.g. plain HTTP under WebSockets) with a sideline cooldown
  (`restoreAfter`, default 30s), an optional per-call primary time budget
  (`primaryTimeout` — a hanging primary is interrupted, sidelined, and the call
  falls to the fallback instead of stalling sync), merged pokes that survive a
  failing primary poke stream, inferred status ("connected" while either
  carrier serves), and version rejections propagating without falling back.
  `BrowserConnectivity.withBrowserConnectivity` now combines `navigator.onLine`
  with the wrapped transport's own status (worst of the two wins) instead of
  replacing it.
- 1b8b120: URL-keyed subscriptions over the mirror channel (ADR-0029 section 2, issue #159).
  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@legation/effect` itself does not know the URL grammar (ADR-0006), so `@legation/jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
  - An explicit pin now registers its edge windows. `Client.subscribe(read)` with `include` holds the foreign windows the read's edges select — `ClientView.pinEdges`, a new member of the view: `Related.trackEdges` (the relational read's reconcile loop without its join) over an owned engine, the relational registration with the host over a connected one — until the last pin releases, and records the edge selects on the ledger entry, so a read with `include` is covered by a pin that declared the edge (ADR-0029 rule 4). The commerce shell's `myCartItems` pin (`include: { variant: true }`) now syncs its edge window. Release stays symmetric with the pin count; the ledger update and the registration it decides are one critical section.
  - A relational registration no longer waits on the network: `Related.relatedWith` (behind `observe` with `include`, `related` and now pins) runs its pulls in the background, one at a time with one queued, so a stalled transport delays rows and never blocks the caller; a failed pull only delays rows (an offline `Client.make` no longer dies).
  - Engine subscriptions are counted where two registrations can hold one window: `ClientView.fromEngine` and `EngineHost` register through `Subscriptions.counted(engine)` — idempotent, so a tab hosting for others (`ElectedHost`) counts once for both fronts — and a relational read's own root subscription ending beside an explicit pin, or one relational read's foreign window beside another's, no longer drops the window from the engine's set-based subscription list.
  - The mirror protocol gains `SubscribeUrl` / `UnsubscribeUrl` (`{ mirrorId, url }`): a page with no `Client` posts them on the channel, and an `EngineHost` built with `nodes` and `urls` parses, plans and registers the URL's root and edge windows under that `mirrorId` — a thin adapter over the existing `Subscribe` and `SubscribeRelated`, refcounted and swept like any mirror's registrations. `EngineHost`'s `registry` defaults to `nodes.collections`. `ServiceWorkerHost.run` and `ElectedHost.run` forward `nodes` / `urls`; `ElectedHost`'s Client takes `urls` too.
  - `Query.tryPlan(nodes, read)` is `Query.plan` with its `QueryError` as a typed failure.

### Patch Changes

- 4c59860: Add `observeChanges(subset, options?)`: a public row-level change feed
  (`RowChange`, #115) on `ClientEngine`, `ClientView`, and `Mirror` alike
  (ADR-0021), for keyed-list bindings, side-effect subscriptions, and delta
  pipelines that today have to diff `observe()`'s pages by hand. Batched per
  view-step:
  - `enter`/`exit` are anchored to the subset's windowed result — a predicate
    or limit-boundary crossing (an insert pushing the last visible row out, a
    delete pulling the next one in) produces the pair a consumer diffing two
    pages would derive; `update` marks a same-membership value change.
  - A `Rebuild` (the optimistic overlay shifted) or a seq-gap collapse (a
    bounded change hub dropped one or more changes) emits a `reset` marker
    followed by fresh `enter`s for the current window, rather than a diff
    against unknown prior state.
  - `{ includeInitial: true }` emits the current window as `enter`s in the
    first batch, with the same subscribe-before-snapshot guard `observe`
    already uses (#84) — a late subscriber sees exactly one batch, no gap or
    duplicate row.

  `ClientEngine` derives batches from the same incrementally-maintained
  `LiveView` window `observe` already keeps (surfaced, not recomputed);
  `Mirror` — which has no local `LiveView` — diffs the whole-page updates its
  host already broadcasts, so both hosts emit identical batches for identical
  page transitions. `@legation/browser`'s `ElectedHost` switches an observer
  onto whichever `ClientView` (mirror or owned engine) is currently active, so
  `observeChanges` works unchanged across a leader-election transition too.

  A confirmed-row pull and a plain local mutation (#109's delta-maintained
  overlay tracks a mutator's local handler directly and publishes exactly what
  it did) both diff precisely; `Rebuild` is reserved for cases the overlay
  genuinely can't diff — a pull racing a still-pending mutation, an unknown
  mutator, a reset (`Clear`) patch — or a seq-gap collapse.

  Move events are not yet part of the contract: `LiveView` rows carry a stable
  position (#112) at runtime, but a row repositioned by a neighbor's
  insert/delete without its own value changing isn't distinguished from
  "unchanged" here — a consumer that needs order re-derives it from a paired
  `observe()` or the position of `enter`s within a batch, pending that
  follow-up. See `docs/observing-row-changes.md` for the framework-binding
  guide (a Svelte 5 keyed-list example) and the `runOnChanges`-style
  side-effect pattern.

- a874acb: Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
  packages (no engine API changes; build, typecheck, and the full test suite pass
  unchanged).

  The version is now centralised in a root **Bun catalog**
  (`package.json` → `workspaces.catalog`): every package's `devDependencies`
  reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
  published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
  Every example is a workspace member so they share the same `effect` version
  as the engine instead of pinning its own.

- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@legation/effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@legation/effect/internal` subpath for adapter authors, which the sibling `@legation/*` packages now compose from.
- Updated dependencies [2a1f63c]
- Updated dependencies [a94df19]
- Updated dependencies [d76b04d]
- Updated dependencies [6f53fb1]
- Updated dependencies [1c56914]
- Updated dependencies [615e792]
- Updated dependencies [4709f41]
- Updated dependencies [8a8adfc]
- Updated dependencies [8995115]
- Updated dependencies [8995115]
- Updated dependencies [87fa7a5]
- Updated dependencies [822001c]
- Updated dependencies [4c59860]
- Updated dependencies [961e604]
- Updated dependencies [5937efe]
- Updated dependencies [08ac9cd]
- Updated dependencies [1fc3725]
- Updated dependencies [8995115]
- Updated dependencies [8a8adfc]
- Updated dependencies [025fabb]
- Updated dependencies [0b8fccb]
- Updated dependencies [e7369e1]
- Updated dependencies [8995115]
- Updated dependencies [01a8c64]
- Updated dependencies [be4be06]
- Updated dependencies [cc2f5b7]
- Updated dependencies [5496ddf]
- Updated dependencies [19eb4b0]
- Updated dependencies [a874acb]
- Updated dependencies [38c3147]
- Updated dependencies [454e75c]
- Updated dependencies [2003cd6]
- Updated dependencies [94d6327]
- Updated dependencies [91f07db]
- Updated dependencies [6e9e119]
- Updated dependencies [6c2c802]
- Updated dependencies [a1b95d4]
- Updated dependencies [c105fbf]
- Updated dependencies [0644af5]
- Updated dependencies [4b05d55]
- Updated dependencies [82911cc]
- Updated dependencies [6f54de8]
- Updated dependencies [eb9555a]
- Updated dependencies [c0ab703]
- Updated dependencies [c47786c]
- Updated dependencies [501b12c]
- Updated dependencies [7f1efac]
- Updated dependencies [cf0b26c]
- Updated dependencies [ddb1fda]
- Updated dependencies [f54f568]
- Updated dependencies [fc880dc]
- Updated dependencies [9cbd160]
- Updated dependencies [0bebedf]
- Updated dependencies [b4d2b80]
- Updated dependencies [2201b4c]
- Updated dependencies [0cdefe7]
- Updated dependencies [7e11e61]
- Updated dependencies [6175e38]
- Updated dependencies [caf4761]
- Updated dependencies [7e94abc]
- Updated dependencies [4fbd0b7]
- Updated dependencies [9d2f21b]
- Updated dependencies [3016170]
- Updated dependencies [c671ccf]
- Updated dependencies [fb2a992]
- Updated dependencies [83bcf76]
- Updated dependencies [bf9054d]
- Updated dependencies [e40c73a]
- Updated dependencies [a01f43b]
- Updated dependencies [9a6426b]
- Updated dependencies [fc880dc]
- Updated dependencies [e34bc24]
- Updated dependencies [0470e1c]
- Updated dependencies [439f449]
- Updated dependencies [3a88118]
- Updated dependencies [1b8b120]
- Updated dependencies [b4489c5]
  - @legation/effect@0.2.0
