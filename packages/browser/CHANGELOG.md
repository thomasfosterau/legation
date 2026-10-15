# @thomasfosterau/legation-browser

## 0.2.0

### Minor Changes

- d356db4: Flush the journal after the tab has closed (#213, #246). `BrowserConnectivity`
  flushes on reconnect and return-to-visible, but only while a page is open;
  `BackgroundSync` covers the rest by answering a Background Sync `sync` event
  in the service worker.

  - **`BackgroundSync.listen`** installs the worker's `sync` listener. Call it at
    the top level of the worker script: a worker woken for `sync` dispatches the
    event straight after evaluating the script, so the listener holds the event
    open (up to `readyTimeout`) until a host attaches, then flushes. Its
    `identity` option is **required** (see below).
  - **`ServiceWorkerHost.start({ backgroundSync })`** attaches the host's engine
    to the listener for as long as it serves, and registers the tag only when
    the journal cannot drain now: a mutation journaled while the worker is
    offline (`navigator.onLine === false`, or the `offline` option), or a push
    that failed terminally (`syncFailures`). Never on an online write — online,
    Chromium fires a fresh registration's `sync` at once, which would push each
    write on its own and bypass `pushDebounce` and paced compaction.
    `registerOnJournal: false` turns host-side registration off.
  - **`BackgroundSync.register`** is the page-side registration helper. It never
    fails: `"Registered"`, `"Unsupported"` (no `SyncManager` — Safari, Firefox)
    or `"Refused"`, logged at debug level only. Absent Background Sync, the
    journal flushes on the next connectivity signal.
  - **`BackgroundSync.flush`** is the flush itself: `ClientEngine.push`, not a
    replay loop, so exactly-once comes from the backend's ledger and a refused
    write is surfaced as `rejected` rather than discarded. A transport failure
    rejects the event so the browser reschedules it. `"Flushed"` means the push
    completed (possibly with nothing pending).

  Only the library's own tag (`BackgroundSync.defaultTag`, or `tag`) is
  answered. The identity boundary (#212) applies: quarantined entries are
  unreachable from push, and `identity` — the fingerprint of whoever is signed
  in now, as the app resolves it in the worker — is required, so a flush skips
  (`"IdentityChanged"`) whenever the store is not stamped for that identity,
  which catches a tab closed before `Client.reset` ran. An app with no sign-in
  passes `BackgroundSync.identityUnchecked` to opt out explicitly.

  `ServiceWorkerHost`'s docs no longer say Background Sync registration stays
  app code. Periodic Background Sync is still app code, deliberately.

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

- 2ff573c: `BrowserConnectivity.withBrowserConnectivity` now reports connectivity from a
  service worker. A worker has no `window`, so it gets no `online`/`offline`
  events; there the wrapper probes `navigator.onLine` on a timer and emits a
  status change when it flips. When the navigator goes back online, `statusChanges`
  emits `connected` once, even if the transport still reports `disconnected`, so
  the sync loop's push and pull run at once for a worker-hosted engine instead of
  waiting on the push retry backoff (#328). `status` still reads the worse of the
  two signals. Where a `window` exists the `online`/`offline` listeners are
  unchanged, but the reconnect edge applies there too: an `online` event emits
  `connected` once whatever the transport reports. `statusChanges` is therefore
  an edge trigger for the sync loop, not a mirror of `status`; a connection label
  should read `status`.

  The new optional `pollInterval` option sets the probe interval (default
  `"5 seconds"`); it bounds how long a reconnect takes to reach the sync loop.

  Auto-push still does not consult connectivity status: a push attempted while
  the status is `disconnected` goes out anyway, because `navigator.onLine` can be
  wrong and a failed push already backs off. This is documented on the module.

- 5496ddf: Bump the pinned Effect version from `4.0.0-beta.84` to `4.0.0-beta.107` across
  all packages (catalog and exact `peerDependencies`), and move
  `@thomasfosterau/legation-jsonapi` and the commerce example from
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
  `@thomasfosterau/legation-jsonapi` type signatures above changed shape.

- 19eb4b0: Bump the pinned Effect version from `4.0.0-beta.65` to `4.0.0-beta.75` across all packages.

  `@thomasfosterau/legation-browser` now builds its IndexedDB cache store on
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

- fed4634: Peer the Effect v4 release-candidate line through an open floor rather than
  an exact pin (#222), so an app can install `@thomasfosterau/legation-*` beside
  `@thomasfosterau/effect-auth` and `@thomasfosterau/effect-jsonapi` and resolve
  a single copy of `effect`. The published floor is `>=4.0.0-rc.118` (see
  `effect-rc118-floor.md`), on `effect` and on the `@effect/platform-browser` /
  `@effect/platform-node` peers.

  **`@thomasfosterau/legation-jsonapi`**: a repeated shorthand filter key
  (`?filter[name]=a&filter[name]=b`) is read as the comma list it spells
  (`filter[name]=a,b`, an `In` predicate) rather than rejected with a 400,
  because `@thomasfosterau/effect-jsonapi` accepts the repeated-key spelling at
  every list-valued position.

  **`@thomasfosterau/legation-node`** declares `engines.node: ">=22"`, the published floor; CI
  tests on the latest stable Node. The other packages run in browsers and
  workers too and deliberately declare no `engines` (ADR-0003).

- fcc52eb: Target Effect `4.0.0-rc.118`: every package peers `effect >=4.0.0-rc.118`
  (#261), and the `@effect/platform-browser` / `@effect/platform-node` peers use
  the same floor. Install `effect` and every `@effect/*` companion at
  `4.0.0-rc.118` or later together.

  The packages import Effect's modules at their rc.118 paths (`effect/rpc`,
  `effect/http`, `effect/http-api`, …); rc.118 removed the `effect/unstable/*`
  export paths, so the packages don't resolve beside an earlier `effect`.

  **`@thomasfosterau/legation-jsonapi`** depends on `@thomasfosterau/effect-jsonapi@^0.16.1`,
  the first release that peers `effect >=4.0.0-rc.118`.

  **`@thomasfosterau/legation-svelte`** depends on `@thomasfosterau/effect-svelte@^0.4.0`, for
  the same reason.

- 2003cd6: Built-in multi-tab leader election for the no-service-worker degraded
  topology (#119): `@thomasfosterau/legation-browser`'s `ElectedHost.run` wraps
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

  `@thomasfosterau/legation-effect`'s `Mirror` now fails any request still in flight when
  the host it was talking to is gone — either because the mirror's own scope
  closed, or because a second `HostReady` announces the host restarted — with
  a clear `TransportError` instead of leaving the caller's `mutate` /
  `mutateWithAck` / server-fallthrough `read` call hanging forever. A
  mutation already journaled by the old host before it died is never lost:
  it's durable in the shared store and the next host's sync loop picks it up
  regardless of what this caller was told.

- c105fbf: Drive HTTP-cache invalidation from collection changes (#49).

  - **`PullCompleted` enrichment** (`@thomasfosterau/legation-effect`): the `PullCompleted`
    `EngineEvent` now carries `collections` — the distinct collections the pulled
    patch touched (a `Clear` stands for every collection the client currently
    holds, since it resets the whole view). The field is always present. This lets
    a collection-scoped reaction fire even on a client with an empty journal (the
    common case, where a pull emits a `Patch` change and no `ViewRebuilt`).

  - **`HttpCacheInvalidation`** (`@thomasfosterau/legation-browser`): `invalidateOnChanges` forks
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

- e1a028a: Per-row HTTP-cache tags (#207): row-granular cache invalidation, closing the
  collection-level ceiling noted in `.changeset/http-cache-invalidation.md`.

  - **Change feed carries row ids** (`@thomasfosterau/legation-effect`): the `PullCompleted`
    `EngineEvent` now also carries `rows` — the `(collection, id)` pairs the
    pulled patch's `Put`/`Del` ops touched (a `Clear` contributes to
    `collections` only, since it has no finite row list). Always present,
    possibly empty.

  - **Fine tag convention** (`@thomasfosterau/legation-browser`): `HttpCacheInvalidation` gains
    `defaultFineTagFor` — `collection:{name}:{id}`, one level finer than the
    existing `collection:{name}` (`defaultTagFor`). `collectionChanges` now
    yields `Touched` (`{ collections, rows }`) and `invalidateOnChanges` evicts
    the union of both tag sets on every change. The coarse eviction is kept
    deliberately even though every touched row's collection is already implied:
    an aggregate document can be staled by a row it does not yet contain, which
    has no fine tag to match.

  - **Response tagging + budget** (`@thomasfosterau/legation-browser`): `tagsFor(collection,
rowIds)` builds a response's tags — coarse plus one fine tag per row, up to
    `FINE_TAG_ROW_BUDGET` (43, derived in a comment against the real ceiling on
    the `x-legation-cache-meta` header these tags ride on). Beyond the budget, a
    response is tagged coarse-only with `budgetExceeded: true` on the result.
    `tagsForObserved` pairs the same computation with a logged warning and the
    new `legation_cache_tag_budget_exceeded_total` counter
    (`Telemetry.cacheTagBudgetExceededTotal`), so the fallback is observable
    rather than silent.

  Both granularities share one tag spelling across the client-side
  invalidation path and response tagging, so the edge/KV invalidation sink
  (#206) can reuse it unchanged.

- Scope the durable replica to a resolved identity (#212), closing the gap where
  adopting legation would make a multi-tenant app on a shared device _less_ safe
  than what it replaced. The invariant, now in `CONTEXT.md` beside the HTTP-cache
  section: **a durable replica belongs to exactly one resolved identity, and an
  identity change is a reset, not a rebase.**

  Identity is resolved server-side per pull, which is what makes the auth filter
  trustworthy — but the replica the authorised rows land in outlives the session
  that authorised them. A signs out, B signs in, and B's Client boots onto A's
  rows because they are the freshest thing on the device and nothing recorded
  which identity authorised them. A's unpushed journal made it worse: durable,
  causally ordered, and about to go out under B's cookies.

  - **`Identity` (`@thomasfosterau/legation-effect`, new)**: `Fingerprint`, the opaque
    app-supplied token a replica is stamped with — a session-subject hash, **never
    PII and never a credential**, as the type's own docs say. `anonymous` is the
    signed-out principal; `unstamped` is a replica that has never been scoped, and
    equals nothing. `transitionOf` is the whole rule, in one place so boot and
    runtime cannot disagree: `Unchanged`, `Upgrade` (anonymous → signed in, the
    one benign transition), or `Reset`.

  - **`ClientStore` identity boundary**: a new `identity` option stamps the
    fingerprint and compares it on open. A mismatch quarantines the unpushed
    journal under the **superseded** fingerprint, then drops confirmed rows and
    the pull cookie. New surface: `getIdentity` / `setIdentity`,
    `quarantinePending` / `quarantinedMutations` / `quarantines` /
    `releaseQuarantine` / `discardQuarantine`, and `clearCookie`. A boundary that
    cannot be established **seals** the store — every operation fails loudly,
    nothing is served, nothing is destroyed, and the next open retries — rather
    than reporting a boundary that isn't there.

  - **Quarantine is its own keyspace**, which is the security property rather than
    an implementation detail: `pendingMutations` reads the journal and `push`
    reads `pendingMutations`, so a quarantined entry is structurally unreachable
    from any push path — a background flush included — under any identity but the
    one it is keyed by. Mutation ids are preserved rather than renumbered, so an
    entry that was in flight at reset is at worst acknowledged and skipped by the
    backend's exactly-once ledger, never applied twice. Only
    `discardQuarantine` destroys one: no reset and no boot does.

  - **`Client.reset(fingerprint)`** applies the same rule at runtime, dropping the
    Client's window ledger along with the rows so coverage cannot answer the new
    principal from the old replica. `Client.make` takes an `identity` and adopts
    it before the sync loop starts. `identity`, `quarantines`,
    `quarantinedMutations` and `discardQuarantine` round out the surface; a
    Client built with `connect` says the host owns the replica rather than faking
    a reset.

  - **The sync client id is scoped to the principal** while the boundary is on
    (derived from the configured `clientId` plus the fingerprint). Mutation ids
    are a per-client sequence the backend requires to be contiguous, so a second
    principal continuing the first's numbering would push a gap and restarting it
    would collide with ids already applied; scoping gives each principal its own
    sequence, and gives a returning one back exactly the sequence they left.

  - **`IndexedDbClientStore` (`@thomasfosterau/legation-browser`)** takes an `identity`, and
    `layerNamespaced` offers the per-identity replica as the alternative to
    resetting — namespace for a device with a few regular users who switch back
    and forth, reset where sign-ins are one-off or unbounded.

  Opt-in: with no `identity` configured, nothing is stamped, nothing is compared,
  and behaviour is unchanged. Turning it on resets an unstamped replica once,
  which is the safe direction — an unstamped replica is exactly the state this
  boundary exists to distrust.

- a3b2ee4: The JSON:API façade (ADR-0029, issue #166): a fetch handler that answers a
  covered JSON:API `GET` from the replica and stays out of the way otherwise.

  - `JsonApiFacade.fetchHandler({ nodes, api, view, coverageOf, cookie?, resources?, baseUrl?, prefix?, online? })`
    in `@thomasfosterau/legation-jsonapi` builds the façade from the app's `HttpApi`
    (`Convention.reflectResources` gives the `list` / `getOne` routes it
    recognises; those whose type is no node are left to the server), the
    node graph, the replica's view and a coverage source. It presumes the
    api's read endpoints are declared with the graph's codec
    (`JsonApiQuery.querySchema` / `singleRowSchema`) and served by the
    derived handlers, which is what lets a parse failure be answered locally.
    `matches(request)` says whether a request is its business — a `GET` whose
    `Accept` names `application/vnd.api+json` on a reflected route under
    `baseUrl` — and `handle(request)` answers: a covered request gets `200`
    with the document the one writer produces (byte-equal in content to the
    derived REST handler's for the same declarations, the optimistic overlay
    visible as `Client.query` sees it), `Cache-Control: no-store` and
    `x-legation-served-at` set to the replica's CVR cookie (the store's,
    empty until the first pull); a URL the grammar rejects gets the codec's
    `400` document (`RestHandlers.queryErrorDocument`), except an `include`
    the graph does not declare, which the server rules on; an uncovered
    request while offline gets the `503` `offline` error document of
    ADR-0029 §4 (`handler.offline`, with the cookie, also for a forward that
    rejected at the transport). Everything else is `undefined` for the caller
    to forward unchanged: a non-candidate, an uncovered request while online,
    a collection no bound resource declares, and a single-resource request
    whose row the replica does not hold (the 404 is the endpoint's own).
    Coverage is every read `ReplicaDocuments.toCover` names, each judged by
    `coverageOf` — `client.coverageOf`, or the host's registrations below.
    The module lives in `@thomasfosterau/legation-jsonapi` by ADR-0006: it needs this
    package's codec, writer and route reflection plus the standard
    `Request` / `Response` globals, and `navigator.onLine` is an option with a
    guarded default, so `@thomasfosterau/legation-browser` stays free of effect-jsonapi.
  - `EngineHost.run` returns a `Host` whose `registrations` lists what the
    host holds on its mirrors' behalf — root windows, relational registrations
    with their edge selects, both halves of a `SubscribeUrl` with its canonical
    URL while a party holds it by URL — as `Coverage.Subscription`s: the
    ledger a façade's coverage check scans in a worker, where no `Client`'s
    own ledger sees the tabs' pins. A registration is listed once its engine
    registration exists (a relational one once its reconcile loop has
    started; one naming an edge the registry does not declare registers
    nothing) and dropped when the last mirror releases it or is swept.
    `Coverage.verdictOf` and
    `Coverage.coverageOf(nodes, subscriptions)` give the same `Verdict` as
    `Client.coverageOf` over any such ledger; `Client` uses the former.
  - `ServiceWorkerHost.start` serves exactly as `run` does and returns the
    `Host` — the engine and its registrations — for the worker to build the
    façade from; `run` is `start` then serve forever.
  - The commerce worker composes façade, then its unchanged HTTP cache, then
    the network (`examples/commerce/src/service-worker.ts`,
    `src/lib/facade.ts`, `src/lib/host.ts`); the api's shape moves to
    `server/api.ts` so the worker reflects the routes the server serves; and
    the replica test runs the façade over the same seed: every URL the
    shell's pins cover is answered with the served document's bytes, and the
    rest go to the network. `Convention.segmentsOf` and `Convention.isParam`
    are exported.

- 501b12c: The mirror seam sheds its browser-tab coupling: the party served by
  `EngineHost` is any client context — a browser tab, an Electron window,
  an extension, a CLI instance — so the vocabulary now says what the
  contract means. `TabMirror` is `Mirror` (module, namespace, and type),
  `tabId` is `mirrorId` (wire field included), `TabMessage` is
  `MirrorMessage` (`decodeTabMessage` → `decodeMirrorMessage`), the host's
  liveness option `tabTimeout` is `mirrorTimeout`, and
  `MirrorChannel.makeLoopbackPair` returns `{ host, mirror }`. Clean
  break, no aliases; `@thomasfosterau/legation-browser` re-exports the new names.
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
  `subscribe` pins the key). In `@thomasfosterau/legation-svelte`, `namedQuery`,
  `useNamedQuery`, and `useRelated({ subscribe: true })` now work over
  mirror-only runtimes (the internal engine-lookup fallback is removed).
- cf0b26c: The mirror seam moves to core, where ADR-0006's dependency rule places it:
  `MirrorProtocol`, the `MirrorChannel` interface + loopback pair,
  `EngineHost`, and `TabMirror` are exported from `@thomasfosterau/legation-effect` — none
  of them needs a browser global, so Electron windows, extensions, and CLI
  processes can host or consume mirrors without `@thomasfosterau/legation-browser`. The
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

- 06405ed: A covered read is answered from the replica only once the windows its rows link to have been pulled (#426). A window is pulled once a pull that started after it was held has applied, or once an already-pulled window covers it. Each window is marked on its own, so a new edge window does not reset the windows already pulled. A read needs the edge windows its root rows link to, and an unpulled window of a sibling key does not uncover a read that links only to other keys. A relational registration whose root is pulled but whose edge windows are not yet held covers nothing. Before its windows are pulled, `Client.query` falls through to the server (offline, it answers locally, as for any uncovered read), and the JSON:API façade forwards the request online and answers `503` offline.

  The pull state is recomputed, not persisted: after a restart each window starts unpulled until a pull lands. `ClientEngine` gains a read-only `pullCounts`; `ClientView.pulled(key)` answers with a per-window summary (`Coverage.Pulled`); `Coverage` gains `pulledFor` and `windowKey`; the mirror protocol gains a host message, `PulledRegistrations`, which an older mirror ignores (it is an addition, and replaces no message). A host now pulls promptly after a plain subscribe, as it already did for named queries.

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

  - `@thomasfosterau/legation-browser` — WebSocket client transport (`ClientTransport` over the browser `WebSocket` global) and IndexedDB-backed `CacheStore` persistence for offline-first apps.
  - `@thomasfosterau/legation-node` — WebSocket server transport: accepts WebSocket connections (via `ws`) and exposes each as a `ServerConnection` ready to hand to the core `SyncHub`.

- 16889f0: Rename every package from the `@legation/*` scope to
  `@thomasfosterau/legation-*` (#303): `@legation/effect` is now
  `@thomasfosterau/legation-effect`, and likewise for `browser`, `cloudflare`,
  `devtools`, `jsonapi`, `node`, `sql` and `svelte`. Subpath entries keep their
  paths (`@thomasfosterau/legation-effect/internal`,
  `@thomasfosterau/legation-svelte/kit`,
  `@thomasfosterau/legation-devtools/svelte`). Update imports and dependency
  names accordingly; no `@legation/*` name was ever published to npm.

  `Context.Service` identifiers and `Symbol.for` keys follow the package name
  (`@legation/effect/Client` → `@thomasfosterau/legation-effect/Client`, and
  per-package equivalents). The reserved identity sentinels
  (`@legation/anonymous`, `@legation/unstamped`), the `legation/` client-store
  prefixes, metric and span names are unchanged.

- 9a6426b: Sync-loop scheduling (#33). `ClientEngine` grows a configurable scheduler on
  `runSync`, driven by `Effect.Schedule` and the existing `statusChanges` seam:

  - `syncLoop.pushDebounce` auto-pushes after `mutate`/`mutateEncoded`, debounced
    so a burst of mutations coalesces into a single push.
  - `syncLoop.pullInterval` pulls periodically as the correctness backstop, so a
    client converges over pull alone even without pokes.
  - The baseline triggers (pull on poke, push+pull on reconnect) are retained,
    and every scheduling fibre is scoped — interrupted when the engine scope
    closes.

  `@thomasfosterau/legation-browser` adds `BrowserConnectivity.withBrowserConnectivity`, which
  layers `navigator.onLine` + `online`/`offline` + `visibilitychange` onto any
  `ClientTransport` so `statusChanges` becomes truthful for carriers (like the RPC
  transport) that otherwise report themselves permanently connected, and a
  return-to-visible surfaces a poke.

  `@thomasfosterau/legation-jsonapi` `JsonApiSync` now configures the core loop (`pullInterval`,
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

  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@thomasfosterau/legation-effect` itself does not know the URL grammar (ADR-0006), so `@thomasfosterau/legation-jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
  - An explicit pin now registers its edge windows. `Client.subscribe(read)` with `include` holds the foreign windows the read's edges select — `ClientView.pinEdges`, a new member of the view: `Related.trackEdges` (the relational read's reconcile loop without its join) over an owned engine, the relational registration with the host over a connected one — until the last pin releases, and records the edge selects on the ledger entry, so a read with `include` is covered by a pin that declared the edge (ADR-0029 rule 4). The commerce shell's `myCartItems` pin (`include: { variant: true }`) now syncs its edge window. Release stays symmetric with the pin count; the ledger update and the registration it decides are one critical section.
  - A relational registration no longer waits on the network: `Related.relatedWith` (behind `observe` with `include`, `related` and now pins) runs its pulls in the background, one at a time with one queued, so a stalled transport delays rows and never blocks the caller; a failed pull only delays rows (an offline `Client.make` no longer dies).
  - Engine subscriptions are counted where two registrations can hold one window: `ClientView.fromEngine` and `EngineHost` register through `Subscriptions.counted(engine)` — idempotent, so a tab hosting for others (`ElectedHost`) counts once for both fronts — and a relational read's own root subscription ending beside an explicit pin, or one relational read's foreign window beside another's, no longer drops the window from the engine's set-based subscription list.
  - The mirror protocol gains `SubscribeUrl` / `UnsubscribeUrl` (`{ mirrorId, url }`): a page with no `Client` posts them on the channel, and an `EngineHost` built with `nodes` and `urls` parses, plans and registers the URL's root and edge windows under that `mirrorId` — a thin adapter over the existing `Subscribe` and `SubscribeRelated`, refcounted and swept like any mirror's registrations. `EngineHost`'s `registry` defaults to `nodes.collections`. `ServiceWorkerHost.run` and `ElectedHost.run` forward `nodes` / `urls`; `ElectedHost`'s Client takes `urls` too.
  - `Query.tryPlan(nodes, read)` is `Query.plan` with its `QueryError` as a typed failure.

### Patch Changes

- ef59fa7: A durable pull now writes once, and an interrupted pull is never recorded. The
  key-value seam gains an optional `AtomicKeyValue` service on
  `@thomasfosterau/legation-effect/internal`: an all-or-nothing `apply` over
  `set` and `remove` operations. When a host supplies it, `ClientStore` commits a
  pull's rows, cookie, journal trim and unpulled-tail release as one batch, with
  no release record, and a push acknowledgement's park and trim as one batch. A
  store without the service keeps the release-record path from #387, unchanged,
  and an open still finishes a leftover record either way.

  `@thomasfosterau/legation-browser` supplies the service over IndexedDB: one
  `readwrite` transaction on the database and object store the platform
  `KeyValueStore` already uses, so existing databases need no migration. The
  database is opened without a version, so one a later version created still
  opens; the browser store's `KeyValueStore` opens it the same way, in place of
  the platform's, which pins version 1 and fails on a newer database.

  If another connection upgrades that database, or deletes it, the store's
  connections close, since they would otherwise block the change. From then on
  every call fails with "the IndexedDB database was upgraded by another
  connection; reload to continue", and the store does not reopen itself. A
  database without the `entries` store fails its calls with a message that names
  that store, and a sealed store's message now carries the reason from its cause.

- 309f682: Background Sync's flush can now pull between chunks when the journal is larger than half the unpulled bound (see the `@thomasfosterau/legation-effect` changeset). A flush whose pull between chunks fails now rejects its `sync` event with a transport error instead of reporting `Flushed`, so the browser reschedules it and the journal waits for the next flush.
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
  page transitions. `@thomasfosterau/legation-browser`'s `ElectedHost` switches an observer
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

- 62dcb1c: `Hydration.dehydrate` now reads the store as one state. It used to read the
  confirmed rows, the cookie, the journal and the unpulled tail in four separate
  calls, so a pull or a push acknowledgement that landed between them could leave
  a snapshot whose rows lacked an acknowledged mutation's effect, while that
  mutation sat in neither the journal nor the tail. `ClientStore` gains an
  optional `snapshot` member that reads all four together: under the store's lock
  for the memory and key-value stores, and in one read transaction on IndexedDB.
  `dehydrate` uses it when the store offers it and reads member by member
  otherwise, so a third-party store behaves as before.

  The `AtomicKeyValue` seam on `@thomasfosterau/legation-effect/internal` gains an
  optional `readAll`, which the browser's IndexedDB binding supplies as one
  `readonly` transaction over the entries store. A key-value store with that seam
  decodes its snapshot from that single read.

- ae18cb3: Add a one-sentence doc comment to every exported declaration that had none, so editor hovers on the published `.d.ts` say what each export is for. This covers the root `@thomasfosterau/legation-effect` surface (`Backend`, `Server`, `ClientStore`, the `Predicate` and `Aggregate` constructors, …), its `/internal` seams, and the options and config interfaces of the other packages. The `@thomasfosterau/legation-effect` module header now counts seven concepts (Hydration joined ADR-0022's six). Documentation only; no API or behaviour changes.
- d1b01a4: Tested against `effect` 4.0.0 (and the matching `@effect/*` companions); the
  peer floor is unchanged at `effect >=4.0.0-rc.118`.

  `@thomasfosterau/legation-effect` adapts to 4.0.0's stricter, type-only `Schema.brand`:

  - `Node.Id` keeps its signature and runtime behaviour; its internal brand
    identifier is cast to satisfy the new concrete-identifier check.
  - `Node.AnyNode`'s `Id` property is now
    `Schema.Codec<string & Brand.Brand<string>, string>` instead of `Id<string>`.
    4.0.0's `brand<String, B>` is type-only and no longer assignable to a wider
    `brand<String, `${string}/id`>`, so no concrete `Node<"todos", …>` was
    assignable to `AnyNode`. Every concrete node is assignable again, and `Id`
    is still a string-encoded branded id schema; only code that reads `.Id` off
    an `AnyNode`-typed value sees the wider brand.

  Checked the 4.0.0 behavioural changes against the packages and found no impact:
  no use of `partition`/`separate`/`Option.partitionMap`, `Queue.State`,
  `MessageStorage` or `RpcMessage.ExitEncoded`. The RPC client's missed-pong
  handling now fails in-flight WebSocket calls rather than reporting a transient
  error; `RpcTransport.fromOrigin` already treats a failed WebSocket call as a
  `TransportError` and falls back to HTTP. `HttpSyncServer`'s WebSocket route now
  closes with 1000/1001/1011, which nothing in the packages inspects.

- a874acb: Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
  packages (no engine API changes; build, typecheck, and the full test suite pass
  unchanged).

  The version is now centralised in a root **Bun catalog**
  (`package.json` → `workspaces.catalog`): every package's `devDependencies`
  reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
  published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
  Every example is a workspace member so they share the same `effect` version
  as the engine instead of pinning its own.

- c5d3484: README: the `effect` floor (`4.0.0-rc.118`) is now tested on every pull
  request, where CI runs the test suite against it, instead of in a weekly
  canary. The peer range (`effect >=4.0.0-rc.118`) and the tested pin (`4.0.0`)
  are unchanged.
- f829146: Rewrite the `@thomasfosterau/legation-effect`, `@thomasfosterau/legation-node` and `@thomasfosterau/legation-browser` READMEs against the current API. The stubs are replaced by install, usage and API sections with examples that compile against the published entry points: the root `Node`, `Query`, `Mutation`, `Client` and `Server` surface, `HttpSyncServer` on Node, and the browser host, store, cache and Background Sync modules. The `@thomasfosterau/legation-effect` package description now names the ADR-0022 surface instead of the v1 vocabulary. Documentation only; no API or behaviour changes.
- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@thomasfosterau/legation-effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@thomasfosterau/legation-effect/internal` subpath for adapter authors, which the sibling `@thomasfosterau/legation-*` packages now compose from.
- Updated dependencies [2a1f63c]
- Updated dependencies [ef59fa7]
- Updated dependencies [56a2e51]
- Updated dependencies [d09dc65]
- Updated dependencies [db2366a]
- Updated dependencies [97db489]
- Updated dependencies [a94df19]
- Updated dependencies [d76b04d]
- Updated dependencies [6f53fb1]
- Updated dependencies [d675d2e]
- Updated dependencies [1743c2b]
- Updated dependencies [1c56914]
- Updated dependencies [615e792]
- Updated dependencies [4709f41]
- Updated dependencies [f0348b4]
- Updated dependencies [3e29e1b]
- Updated dependencies [a053736]
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
- Updated dependencies [c856d66]
- Updated dependencies [01a8c64]
- Updated dependencies [62dcb1c]
- Updated dependencies [be4be06]
- Updated dependencies [ae18cb3]
- Updated dependencies [be0a44d]
- Updated dependencies [cc2f5b7]
- Updated dependencies [d1b01a4]
- Updated dependencies [5496ddf]
- Updated dependencies [19eb4b0]
- Updated dependencies [a874acb]
- Updated dependencies [c5d3484]
- Updated dependencies [38c3147]
- Updated dependencies [fed4634]
- Updated dependencies [fcc52eb]
- Updated dependencies [454e75c]
- Updated dependencies [2003cd6]
- Updated dependencies [94d6327]
- Updated dependencies [91f07db]
- Updated dependencies [6e9e119]
- Updated dependencies [6c2c802]
- Updated dependencies [a1b95d4]
- Updated dependencies [c105fbf]
- Updated dependencies [e1a028a]
- Updated dependencies [dfb8759]
- Updated dependencies [0644af5]
- Updated dependencies [4b05d55]
- Updated dependencies
- Updated dependencies [82911cc]
- Updated dependencies [9c9f2b0]
- Updated dependencies [7b21d11]
- Updated dependencies [6f54de8]
- Updated dependencies [ab1fb4e]
- Updated dependencies [792d8f5]
- Updated dependencies [a3b2ee4]
- Updated dependencies [eb9555a]
- Updated dependencies [c0ab703]
- Updated dependencies [26ad3f3]
- Updated dependencies [cb0a33d]
- Updated dependencies [912d95d]
- Updated dependencies [7290d2b]
- Updated dependencies [41c33e3]
- Updated dependencies [a77261c]
- Updated dependencies [c47786c]
- Updated dependencies [501b12c]
- Updated dependencies [7f1efac]
- Updated dependencies [cf0b26c]
- Updated dependencies [ddb1fda]
- Updated dependencies [f54f568]
- Updated dependencies [fc880dc]
- Updated dependencies [9cbd160]
- Updated dependencies [0bebedf]
- Updated dependencies [bc4c599]
- Updated dependencies [20a6e18]
- Updated dependencies [b4d2b80]
- Updated dependencies [2201b4c]
- Updated dependencies [0cdefe7]
- Updated dependencies [7e11e61]
- Updated dependencies [6175e38]
- Updated dependencies [caf4761]
- Updated dependencies [821b10d]
- Updated dependencies [9e74a83]
- Updated dependencies [49fd066]
- Updated dependencies [06405ed]
- Updated dependencies [e7f4871]
- Updated dependencies [916d91b]
- Updated dependencies [f829146]
- Updated dependencies [13658a7]
- Updated dependencies [31cfb2c]
- Updated dependencies [a1cea1c]
- Updated dependencies [7e94abc]
- Updated dependencies [4fbd0b7]
- Updated dependencies [9d2f21b]
- Updated dependencies [3016170]
- Updated dependencies [c671ccf]
- Updated dependencies [16889f0]
- Updated dependencies [fb2a992]
- Updated dependencies [22f320d]
- Updated dependencies [652ae7b]
- Updated dependencies [83bcf76]
- Updated dependencies [bf9054d]
- Updated dependencies [e40c73a]
- Updated dependencies [f441941]
- Updated dependencies [a01f43b]
- Updated dependencies [9a6426b]
- Updated dependencies [fc880dc]
- Updated dependencies [e34bc24]
- Updated dependencies [0470e1c]
- Updated dependencies [439f449]
- Updated dependencies [3a88118]
- Updated dependencies [1b8b120]
- Updated dependencies [b4489c5]
  - @thomasfosterau/legation-effect@0.2.0
