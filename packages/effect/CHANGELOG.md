# @legation/effect

## 0.2.0

### Minor Changes

- 2a1f63c: Add `Aggregate`: serialisable aggregate descriptors (`Count`, `Sum`, `Min`,
  `Max`, `Avg`) over a subset's rows, as plain data plus an Effect `Schema` (so a
  future server tier can carry them). `compute` / `computeGrouped` evaluate them
  purely over already-filtered/sorted rows — `Sum` of an empty set is `0`, `Avg`
  of an empty set is `undefined`, `Min`/`Max` are `undefined` when there are no
  numeric values, and non-numeric field values are skipped.

  The `ClientEngine` grows `queryAggregate` / `queryAggregateGrouped` (one-shot
  over the current local view) and `observeAggregate` / `observeAggregateGrouped`
  (live, re-emitting only when the value changes), with a matching `aggregate` /
  `aggregateGrouped` atom surface in `EngineAtoms` and an `aggregate` /
  `aggregateGrouped` store in `@legation/svelte`.

  These are local-tier aggregates: they fold the rows a client has already
  synced. A server-evaluated tier that folds the whole collection is explicit
  future work.

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

- 6f53fb1: Change data capture for out-of-band writes (ADR-0019). Writes that bypass the
  mutators — a cron job, an admin tool, another service, `psql` — can now poke
  subscribed clients through a new `HintSource` seam.

  `@legation/effect` gains `HintSource`: a small, dependency-free seam that
  publishes `ChangeHint`s to the `InvalidationBus` on a scoped fibre alongside the
  SyncServer. `HintSource.fromStream` lifts a stream of hint batches and
  `HintSource.run` forks a source for the caller's scope. A source that publishes
  value-less hints is matched at the collection level by the existing fan-out
  matcher — sound, because over-matching a poke only costs an empty pull.

  `@legation/sql` gains `PollingHintSource`: a tier-2 polling source over the
  existing `SqlExecutor` seam (no new dependency). It polls each table on an
  interval for a cheap change-detector — `COUNT(*)` plus `MAX(versionColumn)` when
  a version column is mapped — and pokes a collection whose detector moved.
  Bounded staleness equals the interval; without a monotonic version column it
  detects only row-count changes, so map a `versionColumn` (or `updated_at`) for
  full coverage.

  Tiers shipped: tier 1 (app publishes `InvalidationBus.publish`) documented as
  the baseline, tier 2 (polling) shipped here. Tier 3 (Postgres `LISTEN`/`NOTIFY`)
  ships as a documented recipe — bring your own pg client — and tier 4 (logical
  replication) is rejected (ADR-0019, citing ADR-0009). See
  `docs/change-data-capture.md`.

- 1c56914: The Client facade (ADR-0022, program step 4): the one-per-thread object
  that runs many Query reads and mutations, with where a read is answered
  being configuration the UI never sees. `Client.make` owns the engine
  (store + transport from context; the sync loop starts automatically —
  the forgotten-runSync bug class ends here); `Client.connect` joins an
  engine hosted elsewhere (service worker, Electron main, a daemon) over a
  `MirrorChannel`. Observing subscribes: live reads register their windows
  for the stream's lifetime through a per-window ledger (one voice per
  window, however many observers), `subscribe` pins a read beyond
  observers, and includes resolve through the view's auto-subscribing
  relational read with the plan's edge windows applied. `Client.fromView`
  builds the facade over any `ClientView`. Additive; the
  server-fallthrough tier is a later step.
- 615e792: `Client.make` gains sensible defaults with full extensibility. Zero wiring works: `Client.make({ nodes, mutations })` is a purely local Client — in-memory store, offline transport (reads and optimistic writes work, the journal retains every intent), sync loop off. `transport: { url }` builds the standard remote setup (sync RPCs over WebSocket with HTTP fallback, via the new `RpcTransport.fromOrigin`); `store`/`transport` accept full implementations; a `ClientStore`/`ClientTransport` in context is still honoured (options win over context, context over defaults), so existing layer-composed apps are unchanged. `clientId`/`clientGroupId` default to random ids — pass stable ones alongside a persistent store. Also adds `Transport.offline`, and `Client.make` no longer _requires_ the store/transport services in its environment type.
- 4709f41: One client surface over engine and mirror (ADR-0021): core gains
  `ClientView` — the narrow surface component bindings consume (query/observe,
  subscribe/unsubscribe, mutate/mutateWithAck with awaited-outcome semantics) —
  with `fromEngine` and a `layer` deriving it from the in-context engine.
  `TabMirror` satisfies it structurally, aggregates derive over any view's
  `observe` (`Aggregate.observe`/`observeGrouped`), and `Related`'s read side
  takes a `ClientView.Reader`, so joins and aggregates work over mirrors
  unchanged.

  For `@legation/svelte`, the seam is what lets the same components run over a
  main-thread engine and a service-worker-hosted mirror with zero component
  changes — the Client the hooks read from context is built over either.

- 8a8adfc: Add `BusBrokers.makeBroadcastChannelBroker`: a concrete `BusBroker` over a
  `BroadcastChannel` for same-machine cross-context fan-out (browser tabs, Node
  worker threads), joining the existing Redis Streams and WebSocket/Durable-Object
  brokers. It honors the bus contract's self-delivery (a `BroadcastChannel` omits
  the sender, so `publish` also offers to this broker's own subscribers).
- 87fa7a5: Add `LiveView`: a modular, incrementally-maintained materialized view — a
  subset's result (filtered, sorted, windowed) kept current by row deltas instead
  of re-scanning the collection. `put`/`del` place or remove a single row at its
  sorted position and the visible page is sliced from the maintained order, so a
  change outside the page never re-sorts it and pagination boundaries are handled
  (an insert pushes a row out of the page; a delete pulls the next one in).

  `ClientEngine.observe` now maintains a `LiveView` per query: on the read path
  (empty journal) it applies the pull's per-row patch deltas incrementally and
  drops re-emits when the page didn't move; it falls back to a full rebuild only
  when the optimistic overlay shifts. `Subset` gains reusable `comparator`,
  `sortFiltered`, and `window` helpers (with `apply` composed from them).

- 822001c: Add **named queries** (`Query`): a read defined once and resolved twice, like a
  mutator. The client resolves a name + args to a `Subset` it renders locally; the
  server resolves the same name + args to the _authoritative_ subset it syncs,
  with the request's identity in hand — so query shaping and permission move to
  the server (it can narrow, scope to a tenant, or add a filter the client can't
  override) while the client still renders from the rows it was sent.
  - `Query.make` + `Query.registry` (client subset factories) + `Query.resolver` /
    `Query.QueryResolver` service (server, context-aware, args-validated).
  - `PullRequest` gains an optional `namedSubscriptions` field; `SyncServer`
    resolves each via the `QueryResolver`, then authorizes and evaluates it
    identically to a client-authored subscription.
  - `ClientEngine` gains `subscribeQuery` / `unsubscribeQuery` / `queryNamed` /
    `observeNamed` and an optional `queries` registry. Backward compatible —
    engines without named queries are unchanged.

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

- 961e604: Delta-maintain the optimistic overlay instead of rebuilding it on every
  mutate. `mutate` now runs the mutator's local handler through a tracked
  writer that patches the cached overlay in place and publishes exactly the
  `put`/`del` ops it performed, so observers fold the delta the same way
  `LiveView` already folds confirmed-row patches — no journal replay, and no
  full re-materialization, per mutation. A pull with pending mutations no
  longer forces a global `Rebuild`: rebase now scopes to the union of the
  patch's collections and whatever the pending-before-this-pull mutations
  touch, falling back to a full rebuild only on a reset (`Clear`) or an
  unrecognized mutator. This is the write-path follow-through anticipated by
  the read-path selective re-evaluation work: per-mutation cost is now
  proportional to the rows a mutation touches, not collection size × journal
  length.
- 5937efe: Add the relational `Predicate.exists` node: a correlated relationship test
  (this row matches if a row exists in another collection whose `where` holds and
  whose `foreignField` equals this row's `localField`). Backends resolve it to an
  allow-set with `Predicate.resolveExists` before evaluation — MemoryBackend over
  its rows, the SQL backend via a `SELECT DISTINCT` subquery (the `Sql` translator
  also compiles `Exists` to a correlated `IN (SELECT …)`). This closes the deeper
  parts of the relational-query and relationship-scoped-auth gaps: server-side
  joins and "visible if you're a member of the project" auth **without
  denormalizing** the join key onto the row. The JSON:API backend can't resolve
  correlated joins over REST and fails closed on `Exists`.
- 08ac9cd: Relationship-scoped read authorization. Add an `IdentityResolver` seam: an
  optional service `(clientGroupId) => Effect<identity>` that `SyncServer` uses to
  populate `SyncContext.identity` on every push and pull, so auth filters and
  middleware see a real, server-resolved principal (completing the auth-token
  story). With identity in hand, relationship-scoped visibility ("an issue is
  visible if you're a member of its project") is expressed as an allow-set
  predicate: the auth filter resolves the principal's permitted keys and returns
  `Predicate.isIn(key, allowed)` over a denormalized key on the row. ADR-0015
  documents the pattern and the deferred join-without-denormalization seam.
- 1fc3725: Add relationship declarations to collections and a protocol-agnostic `Related`
  read over the mirror. A collection can now declare `one`/`many` relationships by
  field mapping (`localField`/`foreignField`); `Collection.registry` rejects a
  duplicate relationship name within a collection and a relationship pointing at an
  unknown collection at build time. The new core `Related` module resolves and
  incrementally maintains those joins over any `ClientEngine` mirror —
  `query`/`observe` (a write to a related row re-hydrates without re-resolving the
  base) and `related` (auto-subscribes the narrowed `foreignField IN (...)` foreign
  subsets and tears them down with the scope). The incremental-join plumbing is
  exposed as a strategy seam (`queryWith`/`observeWith`/`relatedWith` plus
  `fieldMappingStrategy`), and the JSON:API `Relationships` module now delegates to
  it with a linkage-based strategy — no behaviour change for existing users.
  `Related.resolveExistsLocally` renders `Predicate.exists` on the client by
  rewriting each node to an `In` over the synced foreign collection.
- 8995115: `RowChange` (#115) gains `move` and a `position` field on `enter`/`update`
  (#133 item 2, #112's follow-through): `LiveView`'s stable fractional-index
  position, present whenever the source can compute one. A row whose value is
  unchanged but whose neighbors shifted enough to move it — a sibling
  entering/leaving the window re-ranks it — now emits `move` (`position` +
  `previousPosition`) instead of being silently dropped as "unchanged," so a
  keyed-list consumer can place `enter`s and re-sort on `move` rather than
  only appending.

  `ClientEngine.observeChanges` (backed by `LiveView`'s incrementally-
  maintained window) emits `position`/`move`; `Mirror.observeChanges` does
  not — a mirror has no maintained window of its own, only whole-page
  broadcasts to diff, so it can't derive a stable position from a snapshot
  alone. Documented, not silent (`docs/observing-row-changes.md`), which also
  gains an updated Svelte 5 keyed-list example ordering by `position`.

  Purely additive: existing `enter`/`update`/`exit`/`reset` consumers that
  don't read `position` are unaffected.

- 8a8adfc: Live queries re-evaluate selectively: a change event now names the collections
  it touched, so an observer re-runs only when its collection changed, instead of
  on every local change. Pulls publish collection-scoped changes when the journal
  is empty; overlay-shifting events (a mutation, push, or pull with pending
  mutations) still re-evaluate everywhere. A first step toward incremental view
  maintenance — full per-row delta maintenance remains a follow-up.
- 025fabb: Add **`SpecExport`**: emit OpenAPI 3.1 and AsyncAPI 3.0 descriptions of an app's
  sync surface so bespoke clients can be generated in any language (ADR-0017). The
  schema-defined protocol (push/pull/poke) is value-agnostic by design, so a
  generic spec would describe an opaque envelope; `SpecExport` instead
  **specializes** it from the app's own definitions — a `Mutation` variant per
  mutator (its `args` schema), a patch `Put` per collection (its row schema), a
  named subscription per query — so a generated client gets concrete, per-name
  types instead of `any`.

  The pipeline is two steps so new formats are cheap: `build(api)` produces a
  format-neutral `SyncSpec` (a shared JSON-Schema component pool plus each
  message's component name), and `toOpenApi` / `toAsyncApi` (or your own `toX`)
  project it. `openApi(api)` / `asyncApi(api)` do both in one call. OpenAPI emits
  push/pull as the logical `POST {path}/push` and `POST {path}/pull`; AsyncAPI adds
  the streamed poke channel. The emitted schemas are the encoded (wire) form, and
  the documents are plain JSON-serializable values. Needs nothing beyond `effect`,
  so it lives in core (ADR-0006).

- 0b8fccb: Add `Subscriptions`: subscription lifecycle on top of `ClientEngine` —
  reference-counted `acquire`/`release`, a TTL grace period before an unused
  subscription is dropped (default 5 minutes), and `preload`/`preloadQuery` to
  pin a subscription for the session. Releasing keeps the rows for the grace
  window so a quick re-subscribe reuses them; if the grace elapses the engine
  unsubscribes and the next pull drops the rows. This is the read-side lifecycle
  Zero expresses as query `ttl` and `preload()`, built on named queries or raw
  subsets.
- e7369e1: Add Effect-native observability (`Telemetry`): `legation_*` metrics and
  `legation.*` spans wired into the engine's hot paths — client push/pull,
  server push/pull, and fan-out. Counters (pulls, pushes, mutations pushed,
  server pulls, pokes) and a patch-size histogram surface through whatever
  `MetricRegistry`/`Tracer` exporter the host installs (OpenTelemetry,
  Prometheus, …) with no extra dependency. Closes the observability gap from the
  Zero feature-parity audit.
- 8995115: Engine-level reactive window retargeting (#133 item 3): `ClientEngine.
observeWindow(subset)` returns a `WindowObservation` (`rows` + `retarget`)
  whose `retarget({ limit?, cursor? })` widens or advances the SAME open
  observation's window in place — reusing `LiveView`'s maintained order
  (`LiveView.retarget`, #112) instead of tearing the subscription down and
  rebuilding it from scratch — and keeps the engine's tracked subscription in
  step, so the next `pull` fetches the wider window from the server too.
  `ClientView.observeWindow` exposes it over the `ClientView` seam for an
  engine-backed view (present only there — a `Mirror` has no maintained
  window of its own to retarget). `Subscriptions.acquireWindow` composes the
  usual refcounted subscribe/release with it for callers that want lifecycle
  management alongside retargeting.

  `@legation/svelte`'s `useConnection` (`hooks.svelte.ts`) now retargets
  through this seam for the common case (no `include`d edges, an engine-backed
  view): `loadMore`/`reset` widen/shrink the same open observation instead of
  letting `pages` force a resubscribe. A joined read, or a mirror-backed
  connection, falls back to the original resubscribe-per-page behavior,
  unchanged. No public API changes — `useConnection`'s signature and observed
  behavior (growing window, `hasMore`, `reset`) are the same; only the
  underlying re-registration is gone.

- 01a8c64: Coverage by conjunct subsumption with strict windows (ADR-0029 section 3, issue #162). `Client.query` no longer requires an exact subset-hash match to answer from the replica: a read is served locally when some subscription in the Client's ledger covers it. A subscription covers a read when it is on the same collection; its window is absent (neither limit nor cursor), or the read asks for a prefix of the identical window (same order, same cursor, and a limit at most the subscription's when it has one); and, canonicalised to sets of top-level conjuncts, the subscription's set is a subset of the read's (an unwindowed subscription) or the same set (a windowed one, which holds only a window of its own predicate's rows). Every `include`d edge must be among the subscription's edge selects, with a paginated edge's `first` at most the subscription's. `Or` and `Not` subtrees compare structurally as whole conjuncts; nothing is inferred through them, and full implication is not built.

  Behaviour change for the mirror and the owned engine alike: more reads are answered locally. A `Client.query` for a filtered page under an unwindowed subscription of the collection now stays local instead of falling through; under a windowed subscription (the commerce shell's `{ collection: "products", order: ["id"], first: 100 }`) a narrower read still falls through, because the strict window never covers a different predicate, a different sort, a different cursor or an unwindowed read. An explicit pin registers only its root window, so a read with `include` is not covered by it until #159 registers a pin's edge windows. Explicit pins are now counted, so two pins of one root release one at a time. The rule lives in `Coverage` (`@legation/effect/internal`), and `Client.coverageOf(read)` reports which subscription covers a read, for devtools.

- be4be06: Add `Derive`: client-local **derived live queries** as bare, composable
  combinators over observed sources — `filter` (arbitrary JS predicate),
  `map`/`select`, `join` (arbitrary key equality, inner + left), `groupBy`
  returning grouped rows, `distinct`, and `orderedWindow` (orderBy + limit). This
  is the client-side expressiveness tier (#114): the arbitrary joins, DISTINCT,
  row-level GROUP BY, and computed/cross-field predicates the serializable
  `Subset`/`Predicate` wire language deliberately does not carry, done in memory
  over already-synced rows.

  Each combinator takes any source satisfying the `ClientView.observe` shape — an
  owned engine, a mirror, or **another combinator**, so queries compose from
  queries — and is maintained **incrementally** from keyed row deltas by pure
  engines (`Incremental`), never refolded per change. Per ADR-0027 these are
  #114's combinator engines, not a separate operator core: each mirrors a proven
  seam's technique — `orderedWindow` the `LiveView`/`OrderedTree` order, `join`
  `Related.makeJoinEngine`'s keyed buckets + reverse index, `groupBy`
  `Aggregate`'s running-fold-plus-`byId`. Each carries a delta-in/delta-out
  property test against a naive from-scratch recompute.

  Results are an Effect `Stream` and, via `Derive.atom`, an Atom on the standard
  reactivity surface, so framework bindings need nothing new. Leaf subscriptions
  compose through the refcounted `Subscriptions` manager (`Derive.observed`) and
  release on scope close, tearing the whole chain down together.

  **The boundary rule (ADR-0027): derived combinators never widen what syncs.**
  They see only the rows a client already holds; the serializable Query/Subset
  tier alone decides what the server ships. Both `Incremental` and `Derive` live
  behind `@legation/effect/internal` (read-layer machinery, no new public noun).
  ADR-0027 (client-local IVM delta model) records the two-tier read model and the
  never-widens-sync rule these consume.

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

- 94d6327: Server-fallthrough reads (ADR-0025, ADR-0022 program step 6): a third protocol operation, `read` — a point-in-time batch subset evaluation under the same deny-by-default auth filters as pull, with no CVR involvement. `Client.query` now answers from the replica when the read's root window is in the Client's ledger and falls through to the server otherwise (degrading back to the local answer when the transport offers no `read` or the server is unreachable); results never enter the replica. Includes resolve through the fallthrough in at most two round trips with the same plan and windows as local reads. The hosted tier forwards reads over the mirror protocol (`Read`/`ReadResult`). `ServerHandler.handleRead` is required; `ClientTransport.read` and the new `SyncMiddleware.onRead` hook are optional.
- 91f07db: ADR-0023's topic-derived fan-out lands as a core seam (internal tier): `FanoutTopics` (the pure topic algebra — coarse `collection` topics plus fine `collection/field=value` topics restricted to the node's derivable set, with write derivation over old and new values), `FanoutBroker` (topic pub/sub with leased registrations; in-process reference implementation), and `FanoutBus` (an `InvalidationBus` over a broker, so `Server.make({ bus })` gets topic-precise cross-room fan-out unchanged). `ChangeHint` gains an additive `oldValues` field — the memory backend supplies it, so an update that moves a row between parents pokes both edge windows and a delete derives from the old row.
- 6c2c802: Close the sync tier's filter surface with a per-node **filterable set** (ADR-0028
  rule d, #154).
  - `Node.make` gains `filterable` (per attribute: the operators a client may use
    — `eq ne lt lte gt gte in nin isnull` — optionally with an explicit literal
    kind) and `sortable`. The resolved declaration is on `Node.filterable` /
    `Node.sortable` and travels onto the derived `Collection` like `indexes`, so
    the server enforces it without Node definitions.
  - Defaults: `id` and every `one`-edge `via` field are filterable by `eq` / `in`
    (kind `text`; a declaration naming a key field widens it, never replaces
    it); `sortable` always includes `id`, and `Node.registry` adds every
    paginated edge's `order` fields to its target's `sortable`, since the
    per-parent edge windows sort by them. The literal kind of a declared
    attribute is derived from its schema's encoded form (`String` → `text`,
    `Number` → `double`, `Schema.Int` → `integer`, `Boolean` → `boolean`); an
    `instant` must be declared explicitly. A declaration naming a field the row
    does not carry, or an attribute whose kind cannot be derived, throws a
    `FilterDeclarationError` at definition time.
  - `Authorization.policy(filters, { collections })` carries the declarations;
    `authorize` checks every client-authored `where` / `orderBy` against them
    **before** the auth filter is AND-ed in and before `Backend.evaluate` runs:
    an undeclared field, a declared field with an undeclared operator, a literal
    of the wrong kind, a client-supplied `Exists`, or an unsortable `orderBy`
    fails the pull or read with an `AuthorizationError` naming the collection,
    field and operator. Today's wire forms `Not(In)` and a null-literal
    `Compare` are checked as `nin` and `isnull`. The check runs on the request
    as the client sent it: the auth filter's own predicate, what a
    `SyncMiddleware` rewrites in, and named-query resolver output are
    server-authored and exempt. A policy built without `collections` keeps the
    previous open behaviour.
  - `NodeBridge.fromResource` / `registry` accept `filterable` / `sortable` per
    resource until effect-jsonapi carries the per-attribute annotation.

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

- 0644af5: SSR hydration, engine seeding, and subset prefetch (#41). A client's durable
  state can now cross a serialisation boundary, and the local view can be warmed
  before the first network round-trip.
  - `Hydration.dehydrate` reads a `ClientStore` into a plain `Snapshot` (confirmed
    rows flattened with their collection, the pull cookie, and the journal);
    `Hydration.hydrate` writes one back, validating it through `SnapshotSchema` on
    the way in so a `dehydrate → JSON → hydrate` round-trip is schema-checked and a
    malformed snapshot fails as a `StoreError`. `SnapshotFromJson` folds the JSON
    step into the decode. The module doc walks the SSR flow (server pulls once,
    `dehydrate`s; client `hydrate`s and continues from the same cookie — no
    refetch) and the seeded-versions caveat.
  - `ClientEngine.seed` writes confirmed rows and reveals them with a single rebuild
    scoped to the seeded collections, so observers render synchronously before any
    transport call. Versions must be genuine backend versions for CVR diffing to
    converge on the next pull; self-invented versions are safe but degrade to the
    reset path.
  - `ClientEngine.ensureSubset` prefetches a subset: it subscribes, and if the
    subset yields no local rows, pulls once. Concurrent calls for the same subset
    dedupe on `Subset.hash`, so a burst of prefetches triggers at most one pull.
  - `ClientStore` gains `listCollections` (the enumeration `dehydrate` walks),
    implemented for both the in-memory and KeyValueStore-backed stores.

- 4b05d55: SSR primitives in `Hydration` (ADR-0020): `snapshot` produces a page snapshot
  over a request-scoped engine (in-memory store + in-process transport to the
  in-context `ServerHandler`, subscribe → pull → dehydrate) under the browser's
  client group id, so the snapshot cookie continues that group's CVR
  conversation on the client's first pull; `isEmpty` / `hydrateIfEmpty` gate
  client boot so a stale snapshot never regresses a durable store's cookie or
  journalled offline mutations; `rowsFor` projects a snapshot onto a subset
  with `Subset.apply` — the synchronous initial value for component hooks
  during SSR and first client render.
- 82911cc: `observeAggregate` / `observeAggregateGrouped` now maintain their fold
  incrementally from row-level deltas instead of re-scanning the subset on
  every emission (#110). `Count`/`Sum`/`Avg` update in O(1) per row delta
  (`Avg` as a running `{sum, count}`); `Min`/`Max` update in O(1) except when
  the row removed or updated away held the current extremum, in which case
  only the surviving values are refolded. Grouped aggregates touch only a
  changed row's old and new group — every other group's value is left
  untouched, both in cost and by reference.

  This applies to unwindowed subsets (no `limit`/`cursor` — the common case:
  aggregating over everything a client has synced) whenever a `Patch` view
  change is available — a confirmed pull's per-row deltas, or (now that #109
  has landed) a `mutate`'s optimistic overlay deltas. A windowed subset, or a
  change too large to diff safely (`Rebuild` — resets, an unrecognized
  mutator, seq-gap collapses), still refolds from scratch, as before. Public
  API and dedup guarantees ("streams do not re-emit when a change leaves the
  aggregate unchanged") are unchanged.

  A benchmark (`bun run bench`) exercises three live aggregates over a 10k-row
  collection under single-row churn.

- 6f54de8: Add engine and server introspection (#45).
  - **Unified `EngineEvent` stream**: `ClientEngine.engineEvents` emits the whole
    sync lifecycle from a single internal hub — `MutationJournaled` /
    `MutationAcknowledged` / `MutationRejected` (the #36 events), `PushStarted` /
    `PushCompleted`, `PullStarted` / `PullCompleted`, `PokeReceived`, and
    `ViewRebuilt` (carrying the scoped collections). `mutationEvents` (#36) is now
    a filtered projection of this one hub, so there is a single source of truth;
    its behaviour is unchanged. The hub stays unbounded for the reason #44 kept
    the mutation hub unbounded — lifecycle events are low-volume, consumer-driven,
    and lossless (observability, not reconstructable via pull).
  - **`EngineIntrospection`** (`Introspection.ts`): a read-only view over a
    `ClientEngine` and its `ClientStore` — `subscriptions` (active subsets,
    including resolved named subscriptions), `journal`, `cookie`, `collections`,
    and `events`. Built over the engine's public read accessors (new
    `activeSubscriptions` / `engineEvents` members) and the store's public reads,
    so it never touches private state. Every member is a plain `Effect`/`Stream`,
    so it drives cleanly through `PromiseFacade`.
  - **Server introspection** (`SyncServer.makeWithIntrospection`): a read-only
    `ServerIntrospection` over the live fan-out state — active client groups with
    their authorised subsets and CVR sizes, plus poke counters. Fan-out behaviour
    is unchanged.
  - **New `legation_*` metrics**: `legation_journal_depth` (gauge, sampled on
    append/acknowledge), `legation_rebase_duration_ms` (histogram, around the
    overlay rebuild), `legation_fanout_latency_ms` (histogram, the server fan-out
    leg), `legation_pull_patch_ops` and `legation_push_mutations` (histograms).

- c0ab703: Keyed reactive mutation-state surface (#116) — TanStack Query's
  `useMutationState` analogue. `ClientEngine.mutationStates` maintains a map
  keyed by `mutationId`, seeded from the journal at boot (a reload shows
  pending intents) and folded forward as mutations are journaled, acknowledged,
  or permanently rejected — regardless of whether they went through `mutate`,
  `mutateEncoded`, or `mutateWithAck` (previously only `mutateWithAck`-registered
  mutations ever settled on `mutationEvents`/`engineEvents`; this fixes that
  gap so the whole journal is observable). Terminal (acknowledged/rejected)
  entries are retained only up to a configurable `mutationStateRetention.maxTerminal`
  bound (default 200), evicted oldest-settled-first, so a mutation storm cannot
  grow the map without limit — the journal stays the durable source of truth
  for pending mutations.

  Exposed at every layer:
  - `ClientEngine.mutationStates: Stream<MutationStateMap>` and `MutationState.ts`'s
    pure fold (`seed`/`journaled`/`acknowledged`/`rejected`).
  - `ClientView`/`Client` gain `mutationStates`, so it works identically over an
    owned engine and a connected mirror (ADR-0021) — a minimal mirror-protocol
    extension (`SubscribeMutationStates`/`UnsubscribeMutationStates` mirror→host,
    `MutationStatesUpdate` host→mirrors) broadcasts the whole map, refcounted
    like a subset subscription.
  - `EngineAtoms.mutationStates` (the whole map) and `EngineAtoms.mutationsFor(mutator)`
    (a derived per-mutator selector).
  - React `useMutationState(mutator?)` — always a plain array, oldest-journaled
    first, no `AsyncResult` handling needed.
  - Svelte `useMutationState(mutator?)` rune (`@legation/svelte`), reactive
    to a `mutator` thunk like `useQuery`'s `read`.

  The todo example's journal panel is written over this surface,
  replacing its bespoke `Introspection`-based wiring, and demonstrates bounded
  terminal retention.

- c47786c: `@legation/sveltekit` is merged into `@legation/svelte` as the
  `@legation/svelte/kit` subpath, and `Hydration` moves to the public
  `@legation/effect` surface.

  The split was never a dependency boundary: the SvelteKit package contained no
  Svelte code, and its whole `@sveltejs/kit` coupling was two `import type
{ Cookies }` statements — type-only, erased at build. `@sveltejs/kit` is now an
  **optional** peer dependency of `@legation/svelte`, so a non-Kit Svelte app
  pulls nothing extra, and only `@legation/svelte/kit` needs it.

  The bindings shrink to one surface, on one entry point. The `Readable`-store
  tier (`Query.query` / `namedQuery` / `aggregate` / `related`,
  `Mutation.getMutate`, `undoControls`, and `Runtime.setEngineRuntime`) is
  removed: it duplicated the rune hooks, and the package's own `svelte >= 5.40`
  peer already ruled out the Svelte 4 audience it existed for. The hooks move
  from the `/Runes` subpath to the package root — they are the API, so they are
  not something to reach for separately — and gain **`useUndo(manager)`**, the
  rune equivalent of the store-based `undoControls`, so nothing is lost. The
  root is now a `.svelte.js` module with a `svelte` export condition; the
  namespaces are gone, so `setClientRuntime` and the hooks are flat named
  exports.

  Hydration is now a core concept rather than a SvelteKit one. `Hydration` is
  exported from `@legation/effect` (it was behind `/internal`) and speaks
  `Query.Read` instead of `Subset`: `snapshot({ nodes, reads })` and
  `rowsFor(snapshot, nodes, read)`. `@legation/svelte/kit` keeps only the
  framework's share — the client-group cookie, a `load`-shaped wrapper, and
  `clientRuntime`, which replaces `engineRuntime` and returns the `Client`
  runtime `setClientRuntime` expects (built on `Client.make`, so it starts the
  sync loop itself).

  Migration: `@legation/svelte/Runes` → `@legation/svelte`;
  `Runtime.setClientRuntime` → `setClientRuntime`;
  `@legation/sveltekit` → `@legation/svelte/kit`;
  `engineRuntime({ engine: {...} })` → `clientRuntime({ nodes, mutations, ... })`;
  `setEngineRuntime` → `setClientRuntime`; `query(subset)` → `useQuery(() => read)`;
  `getMutate()` → `useMutation()`; `undoControls(m)` → `useUndo(m)`;
  `Hydration.rowsFor(snapshot, subset)` → `Hydration.rowsFor(snapshot, nodes, read)`.

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
- ddb1fda: Restructure the repository into a monorepo of sync-engine packages, with package boundaries drawn by dependency footprint:
  - `@legation/effect` — the Effect-native sync engine. Everything that needs only a dependency on `effect`: sync keys, cache stores, the write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, a durable offline outbox, the client/server sync protocol, transports, conflict resolution, the TanStack-Query-style client (queries/mutations/subscriptions/offline sync), the service-worker/edge HTTP cache engine with KeyValueStore persistence, the server-side sync hub with fan-out, and promise facades for non-Effect consumers.
  - `@legation/jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors and query/mutation descriptor builders that plug into the core engine.

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

- fc880dc: Fix a gap in `ClientEngine.mutationStates` (#116): a mutation compacted out of
  the journal by a paced strategy (`Paced.ts`'s debounce/throttle/coalesce, via
  `dropIfPending`) never transitioned off `"pending"` — the entry stayed stuck
  showing an in-flight mutation forever, even though the journal no longer had
  it. `MutationPhase` gains a `"dropped"` phase (and a matching
  `MutationDropped` `EngineEvent`/`MutationEvent`), and `dropIfPending` now folds
  every compacted id to it, so a mutation-timeline consumer (a devtools journal
  panel, #120) never shows a phantom pending entry for a compacted mutation.
- 9cbd160: The Node/Edge resource model lands (ADR-0022, program step 2): `Node.make`
  defines a typed resource — attributes plus edges (`Edge.one` with its
  foreign-key `via`, `Edge.many`/`Edge.paginated` naming their `inverse`,
  order as part of a paginated edge's identity) — with per-type branded ids
  (one-edge fields carry the target's brand) and declared `hintKeys`.
  `Node.registry` closes and validates the graph (targets exist, inverses
  resolve to a matching one-edge) and derives the engine's
  `CollectionRegistry`, so existing engines, `Related` joins, and auth
  filters consume Node definitions today; `Node.derivableSet` exposes the
  ADR-0023 fan-out fields. Additive — nothing existing changes.
- 0bebedf: `LiveView` (the incrementally-maintained live-query result behind paginated
  queries) no longer rebuilds its ordered set as a copied array on every change
  (issue #112). The maintained order and its id index are now persistent
  weight-balanced trees (`OrderedTree`, a new internal module): `put`/`del` cost
  O(log n) instead of O(n), and reslicing a window is O(log n + window) — a
  100k-row maintained set with steady single-row churn no longer pays for a
  full array copy on every unrelated-row update (see the new
  `live-view-churn.bench.ts`).

  In-window rows now carry a stable `FractionalIndex` `position`:
  assigned when a row enters the window, dropped when it leaves, and left
  untouched when the row didn't move relative to its neighbors — the primitive
  a future row-level delta feed needs to express a reorder as a move instead of
  a page diff. `LiveView.retarget` widens a `limit` or advances a `cursor` over
  the _same_ maintained order, with no re-materialization — the pure half of
  the "load more widens one window" story (`useConnection`, ADR-0024); wiring
  this into an open `ClientEngine` subscription so the client never
  re-registers on "load more" is flagged as future work in `LiveView.ts`.

  `Subset.comparator` now tie-breaks on row id, making it a genuine total order
  even with an empty `orderBy` (previously every row tied, and `LiveView`'s
  delta-location degraded to a full scan). Because every backend
  (`MemoryBackend`, `@legation/sql`'s `SqlBackend`,
  `@legation/jsonapi`'s `JsonApiBackend`) already finalizes order/limit/cursor
  locally via `Subset.apply`, this same comparator is the sole ordering
  authority for both client and server — a subset with no declared `orderBy`
  now sorts by id ascending everywhere instead of an unspecified order. The
  collation decision (why this rules out a client-local collation option, and
  what a real one would require) is recorded in
  `docs/adr/0026-subset-ordering-and-collation.md`.

- b4d2b80: Paced mutations (#117): `Paced.debounce`/`Paced.throttle`/`Paced.coalesce`
  (`@legation/effect/internal`) pace rapid mutation intents — a text field
  autosaving per keystroke, a slider, a cart-quantity stepper — into a handful
  of journal entries instead of one per call, built entirely on
  `ClientEngine.mutateWithAck` and Effect's own timing primitives (no new
  dependency, no general-purpose pacer module).

  Design: every call always journals immediately through the ordinary
  `mutateWithAck` path (full durability, the usual optimistic overlay render),
  then a compaction step drops the caller's own previous still-pending entry
  for the same key via the new `ClientEngine.dropIfPending`. `debounce`/
  `throttle` additionally buffer intermediate calls in memory between a leading
  and a trailing/periodic flush, so a 50-call burst produces at most a couple of
  journal writes — the tradeoff being that the buffered args between flushes
  are lost on a crash inside the window (`coalesce` has no such window: every
  call is durable, at the cost of short-lived extra entries before the next
  call's compaction).

  `dropIfPending` never touches an entry a `push` may already have sent:
  `ClientStore.dropPending` (a new store primitive, symmetric to `acknowledge`
  but by explicit id set) only ever removes ids the engine has confirmed are
  still in its pending set with no push currently in flight — the ADR-0008 hard
  boundary (never mutate or reorder a pushed journal entry) is enforced inside
  the engine, not trusted to callers.

- 2201b4c: Paginated-edge sync windows (ADR-0024, ADR-0022 program step 5): an included paginated edge's `first` now registers one windowed subset per parent row — `(foreignField = parent, edge order, limit)` — so the replica syncs the window instead of the whole dependent collection. `Collection.Relationship` gains the `"paginated"` kind with its declared order (derived from `Edge.paginated` by `Node.registry`), relational reads select edges as `{ name, first? }` (bare names still accepted), and the mirror protocol's related registrations carry the window (`SubscribeRelated.edges` replaces `names`). Windows follow parents entering and leaving the root window; displaced rows leave the replica through ordinary CVR union diffs.
- 0cdefe7: Per-row and per-mutation durable storage for the KeyValueStore-backed `ClientStore`. Confirmed rows now persist one key each at `row/{collection}/{id}` behind a small `rowIndex/{collection}` id-array, and pending mutations one key each at `journal/{clientId}/{mutationId}` behind a compact ordered `journalIndex`. A `putRow`/`appendMutation` rewrites a single value plus a tiny index instead of the whole collection or journal, and `acknowledge` drops acked mutation bodies without rewriting the survivors.

  `ClientStore` gains a batched `applyRowOps`, through which the engine's pull path now routes: a patch is grouped by collection so each collection's id-index is rewritten at most once per patch and each row value written once — patch-apply value I/O scales with patch size, not collection size (a checked-in `bun run bench` counts the KVS writes to demonstrate it).

  A store opened at the previous whole-blob layout is migrated forward transparently on first open (rows, journal, counters, cookie split losslessly), stamped with a `__layout` version key; a corrupt legacy blob falls back to clearing rows and the cookie so the client re-pulls. A new `journalHighWater` option (KVS-only) makes `appendMutation` fail with a clear `StoreError` rather than ever silently dropping a mutation intent; the failure surfaces through `mutate`.

- 7e11e61: Permanent mutation rejection semantics (#35). A mutator handler can now fail
  with the new `MutationRejected` error to mark a failure permanent (failed
  validation, revoked permission, violated business rule). The backend records
  the mutation as processed — bumps `lastMutationId` atomically **without**
  applying effects — so a poison mutation is acknowledged and skipped rather than
  wedging the queue: mutations behind it still apply, and the client drops the
  optimistic effect on the next rebase with no app code. A `BackendError` keeps
  today's transient behaviour (abort the batch, client retries).
  - `Backend.ApplyResult` gains an optional `rejected` list; `PushResponseSchema`
    gains an additive optional `rejected` field (older clients ignore it, and the
    per-mutation outcome surface #36 reads it).
  - `MemoryBackend` rolls a rejected mutation's staged writes back (snapshot),
    `SqlBackend` via a per-mutation `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, and
    `JsonApiBackend` classifies HTTP 4xx (except 408/429) as permanent rejections.
  - `BackendContract.verifyBackendContract` gains a rule covering both failure
    classes.
  - `CONTEXT.md` documents the "transient failure" vs "permanent rejection"
    glossary entries.

- 6175e38: Predicate-aware fan-out matching. A committed write now pokes a client group
  only when some hinted change plausibly affects one of its subscriptions,
  rather than every group whose subscriptions touch the hinted collection.

  Change hints gain an optional, wire-compatible `values` field carrying the
  current row values of the PUTs in a change (`MemoryBackend`, `SqlBackend` and
  `JsonApiBackend` populate it best-effort; a backend that can't cheaply produce
  a value omits it). An old, value-less hint decodes and behaves exactly as
  before. The `SyncServer` fan-out loop matches a value-carrying PUT against the
  subscription's predicate, a delete against the group's last-synced CVR, and
  falls back to the collection-level match for value-less hints and `Exists`
  predicates (soundness first — over-matching is safe, under-matching would
  delay convergence). A new `legation_pokes_suppressed_total` metric counts the
  pokes predicate matching avoids.

- caf4761: `Predicate` evaluates under Postgres's three-valued semantics (ADR-0028,
  #155). This is a behaviour change for rows whose filtered field is `null` or
  absent.
  - `Predicate.evaluate(predicate, row)` returns `Option<boolean>`: `Some(true)`,
    `Some(false)`, or `None` for unknown, with Kleene `And`/`Or`/`Not`. An
    absent attribute is NULL. `Predicate.test` is now
    `Option.getOrElse(evaluate(...), () => false)`, so every caller keeps its
    boolean signature but a row matches only when the result is definitely
    true. Rows with a NULL or absent field therefore stop matching `ne`,
    `Not(eq)`, a `Not(In)` miss and `NotIn`, exactly as they do in SQL. An app
    that relied on `ne` returning NULL rows must add an explicit `isNull`
    disjunct.
  - Two wire-additive nodes: `IsNull { field, negated? }` and
    `NotIn { field, values }`, with constructors `Predicate.isNull`,
    `Predicate.isNotNull` and `Predicate.notIn` (also on the typed
    `Subset.for` builder). `Predicate.eq(f, null)` desugars to `isNull(f)` and
    `Predicate.ne(f, null)` to `isNotNull(f)`, so existing call sites keep
    their meaning — and `eq(f, null)` now also selects rows where the field is
    absent. A wire `Compare` or `In` carrying a `null` literal evaluates to
    unknown, as in Postgres; that form is deprecated.
  - Text compares by Unicode code point (`Predicate.compareText`), the order of
    Postgres `COLLATE "C"` and SQLite `BINARY`, instead of UTF-16 code unit;
    the two differ only where astral characters meet U+E000–U+FFFF. Booleans
    order `false < true` under `lt`/`lte`/`gt`/`gte`.
  - `Subset.comparator` sorts NULL and absent values after every non-null
    value ascending and before them descending (Postgres's default); it used
    to sort them first in both directions. The row-id tie-break is a code-point
    comparison. Existing cursor pages over text or nullable sort keys may
    re-order once on upgrade.
  - `CollectionIndex` keeps one bucket for NULL-or-absent that `eq`/`In`/range
    lookups never return and `IsNull` reads directly; `ne`, `NotIn` and
    `IS NOT NULL` stay residual conjuncts. Sorted runs use the code-point
    comparator. The index is proven equal to the full scan over the
    differential corpus.
  - `@legation/sql`: `Sql.compileWhere` compiles `IsNull` to `IS NULL` /
    `IS NOT NULL` and `NotIn` to `NOT IN (…)` (empty list → `1 = 1`). The
    `BackendContract` corpus now generates NULL, absent and astral text.

- 7e94abc: `Related.observeWith` now propagates row deltas through the join instead of
  re-grouping whole collections (issue #111, part of the #108 IVM umbrella): a
  foreign-row change updates only the one or two `fk → rows` buckets its old and
  new key select and re-hydrates only the base rows keyed to those buckets,
  instead of rebuilding the collection's whole group index and re-hydrating the
  full base page. A base-row change re-hydrates only that row. A linkage shift
  (which foreign collections are targeted) diffs the targeted set against the
  previous one — the same diff-and-release shape `reconcile` already uses for
  subscriptions — and starts/stops only the newly (un)targeted collections'
  observers, instead of tearing every observer down and re-priming from scratch.
  The public API (`related`/`observeWith`/`relatedWith`) and ADR-0024
  auto-subscription reconciliation are unchanged. The new `Related.makeJoinEngine`
  is the pure, Effect-free incremental engine behind this, exported so its
  equivalence to a from-scratch hydrate (`Related.hydrateFromScratch`) can be
  property-tested directly.
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

- 3016170: Retry/backoff policies for the sync loop (#34). `ClientEngineOptions.retry`
  takes per-leg `Schedule`s for `push`, `pull`, and the `pokes` stream; unset
  legs use `defaultRetryPolicy` (exponential from 1s, factor 2, delay capped at
  30s, bounded to 5 retries — mirroring TanStack Query's 1s→30s, no jitter so it
  composes predictably).

  `runSync` now applies the policy instead of swallowing failures: only
  `TransportError` is retried (`StoreError`/`MutatorError` are not transient and
  propagate immediately), and the poke stream re-establishes with backoff via
  `Stream.retry`. Terminal failures after policy exhaustion are surfaced on a new
  `ClientEngine.syncFailures` stream and counted in
  `Telemetry.syncFailuresTotal`, so bindings can show a "sync degraded" state.

  The retry policy composes with the #33 scheduler: the scheduler decides when to
  attempt, the policy decides how an attempt survives transient failure.

- c671ccf: Schema-version negotiation and fleet cookie-reset (#48) — the runtime mechanism
  for ADR-0014's schema-evolution policy (ADR-0018). ADR-0014 stays the policy;
  this ships the hooks.
  - **Protocol.** `PushRequest`/`PullRequest` gain an optional `schemaVersion`.
    Additive and wire-compatible: an old client omits it and still decodes, a new
    server tolerates its absence.
  - **Server acceptor.** `SyncServer.makeWith` / `layerWith` take
    `acceptSchemaVersion?`; a rejected version fails `handlePush`/`handlePull` up
    front with a typed `VersionNotSupportedError` — before any mutation is applied
    or patch computed, so the journal is never poisoned. Distinct from a
    `TransportError` across the in-memory transport seam (the RPC carrier degrades
    it to a `TransportError`, noted).
  - **Client hook.** `ClientEngineOptions` gain `schemaVersion?` (sent on every
    push/pull) and `onUpdateNeeded?`, fired exactly once per ongoing rejection (a
    latch that resets on the next successful request), alongside an `UpdateNeeded`
    engine event. Pending mutations are retained across a rejection.
  - **Local `storeVersion` buster.** `KeyValueOptions.storeVersion?` clears
    confirmed rows + the cookie on a mismatch (so the next pull rehydrates fully)
    while preserving the pending journal.
  - **Fleet reset.** `SyncServer` takes `cookieNamespace?`; bumping it on deploy
    makes every previously-issued cookie unknown, so each client's next pull is a
    reset patch (`Clear` + full puts) — one place to reset the fleet.

- fb2a992: Add secondary field-value indexes over the local store (#113): `eq`/`In`
  predicates resolve via an in-memory hash index and range `Compare`s via an
  ordered index, instead of a full collection scan, in `ClientEngine.query`,
  live-query rebuilds (`observe`, seq-gap collapse), and `Related`'s foreign-index
  priming (which now also narrows its query to the pinned `foreignField IN (...)`
  values instead of reading the whole foreign collection).

  Declare indexed fields on a `Node`/`Collection` (`indexes: ["done", "authorId"]`,
  mirroring `hintKeys`), or pass `autoIndex: true` to `Client.make`/
  `ClientEngine.make` to auto-discover indexable fields from registered subsets'
  predicates. Both are opt-in — zero-config behavior is unchanged, and any
  predicate the index can't narrow (`Or`, `Not`, `ne`, non-indexed fields) falls
  back to today's full scan. Indexes are in-memory only, maintained from
  confirmed-row patch deltas and rebuilt lazily from the store; they are used
  only while a collection's journal is empty (a pending optimistic mutation
  falls back to a full scan for correctness).

  A benchmark (`secondary-index.bench.ts`) shows a ~25-30x speedup for a
  selective point predicate (1/100th match rate) over a 50k-row collection.
  Memory overhead is roughly 300-400 bytes per indexed row per declared field
  (measured via heap snapshots), i.e. ~15-20MB for a 50k-row collection with one
  declared index.

- 83bcf76: The Server facade (ADR-0022, program step 7): `Server.make({ backend,
auth, queries?, middleware?, cvr?, bus? })` builds the one server-side
  object — the protocol handler (push/pull with CVR diffing, mount it on
  any router or carrier) plus `server.broadcast({ collection, ids? })`, the
  single verb for "these resources changed". Pushed mutations broadcast
  implicitly through the push path's hints; `broadcast` covers out-of-band
  writers (cron, admin tools, anything bypassing mutations — ADR-0019 in
  one line). CVR storage and the fan-out bus default to in-memory /
  in-process and swap for scale-out (ADR-0011) without app-code changes;
  ADR-0023's topic-derived fan-out lands behind `broadcast` without
  changing its signature. Additive.
- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@legation/effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@legation/effect/internal` subpath for adapter authors, which the sibling `@legation/*` packages now compose from.
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

- fc880dc: Add `Transport.simulateOffline`: a decorator wrapping any `ClientTransport`
  with a toggleable offline gate (push/pull/read fail with a `TransportError`
  while toggled offline, mirroring a real network drop, so the engine keeps
  mutations in the journal and its sync loop flushes them on reconnect).
  Generalises the offline-gate transport the demo examples each hand-rolled
  into reusable substrate — it now
  backs both examples' offline toggle, and `@legation/devtools`' actions panel
  (#120) offline-toggle action.
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
- 0470e1c: Add a typed query surface over the existing untyped `Subset`/`LocalRow` (purely
  additive — the protocol-level and dynamic surface is unchanged).
  - `Subset.for(collection).make({ where, orderBy, limit, cursor })` builds a
    `TypedSubset<A>`: field names and literal types in `where` (via a
    field-checked `TypedPredicate<A>`) and `orderBy` are checked against the
    collection's row type. It erases to a plain `Subset` at runtime.
  - `ClientEngine.query`/`observe`, `EngineAtoms.liveQuery`, the React `useQuery`
    and the Svelte `query` store now refine their row type to `A` when handed a
    `TypedSubset<A>` (a trust-cast — the read path still never decodes, per
    ADR-0014), so the row type flows through without `row.value as T` casts. Plain
    `Subset` callers are unaffected.
  - `ClientEngine.observe(subset, { select, equals? })` returns a projected
    stream that re-emits only when the projected value changes (reference
    equality by default), so a change to a field the projection ignores no longer
    wakes the observer.
  - Named-query cache/subscription keys (`ClientEngine`'s named subscriptions and
    `EngineAtoms.namedQuery`) now key on `Hash.canonicalJson` rather than
    `JSON.stringify`, so two structurally-equal args objects with different key
    order resolve to the same subscription entry and the same Atom.

- 439f449: Add `Undo`: an optional, additive undo/redo module layered over `ClientEngine`
  (no engine surgery). It follows the **paired-intents** design (the
  `@rocicorp/undo` shape): the caller supplies both directions of a change — an
  `execute` intent and its reversing `undo` intent — and `Undo.make(engine)`
  returns an `UndoManager` whose `run` / `undo` / `redo` replay through the
  ordinary `ClientEngine.mutate` pipeline. Because undo and redo are just
  mutations, they are optimistic, journaled, rebased, and offline-safe like any
  write; the module only owns the history.

  History is **in-memory and per-client** (one manager per engine, a pair of
  stacks in a `SubscriptionRef`) — it does not survive a reload, though the
  journal still carries any pending undo/redo mutations to the backend. `run`
  clears the redo stack (a new action invalidates redo); `undo` and `redo` are
  no-ops (never errors) when their stack is empty. `group(effect)` coalesces every
  `run` made while `effect` runs into a single step: one `undo` replays each
  member's `undo` in reverse order, one `redo` replays each member's `execute` in
  order. `canUndo` / `canRedo` are one-shot effects; `canUndoChanges` /
  `canRedoChanges` are `SubscriptionRef.changes`-backed streams for bindings.

  The **delete-then-undo** criterion is met by the paired-intents pattern: capture
  the row's pre-delete value from the local view at run time and pass it as the
  undo's re-create args, so an undo restores the row exactly.

  `@legation/svelte` gains `useUndo(manager)` — `canUndo` / `canRedo` as runes
  over the manager's change streams, plus `undo` / `redo` handlers. The `todo`
  example wires ⌘Z / Ctrl+Z (Shift for redo) through the manager and documents
  the recipe.

- 3a88118: The unified Query read (ADR-0022, program step 3): `Query.make({
collection, where, include, order, first, after })` declares a read shaped
  like the data — an equality-map `where` (full `Predicate` as the escape
  hatch), edges by name in `include` (with per-edge `first` windows), order
  tokens, cursor pagination — and `Query.plan` compiles it against the node
  graph to a root `Subset` plus edge plans (`Subset`/`Predicate` become the
  plan's internal representation). `Query.run`/`Query.observe` execute reads
  over any `ClientView.Reader`, resolving includes through the existing
  `Related` machinery and applying paginated-edge order + `first` windows to
  the resolved join (true per-edge sync windows land with the
  paginated-edge step). Named queries are the same concept with a name —
  `Query.named` (the old `(name, args)` form of `Query.make` still works via
  overload).
- 1b8b120: URL-keyed subscriptions over the mirror channel (ADR-0029 section 2, issue #159).
  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@legation/effect` itself does not know the URL grammar (ADR-0006), so `@legation/jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
  - An explicit pin now registers its edge windows. `Client.subscribe(read)` with `include` holds the foreign windows the read's edges select — `ClientView.pinEdges`, a new member of the view: `Related.trackEdges` (the relational read's reconcile loop without its join) over an owned engine, the relational registration with the host over a connected one — until the last pin releases, and records the edge selects on the ledger entry, so a read with `include` is covered by a pin that declared the edge (ADR-0029 rule 4). The commerce shell's `myCartItems` pin (`include: { variant: true }`) now syncs its edge window. Release stays symmetric with the pin count; the ledger update and the registration it decides are one critical section.
  - A relational registration no longer waits on the network: `Related.relatedWith` (behind `observe` with `include`, `related` and now pins) runs its pulls in the background, one at a time with one queued, so a stalled transport delays rows and never blocks the caller; a failed pull only delays rows (an offline `Client.make` no longer dies).
  - Engine subscriptions are counted where two registrations can hold one window: `ClientView.fromEngine` and `EngineHost` register through `Subscriptions.counted(engine)` — idempotent, so a tab hosting for others (`ElectedHost`) counts once for both fronts — and a relational read's own root subscription ending beside an explicit pin, or one relational read's foreign window beside another's, no longer drops the window from the engine's set-based subscription list.
  - The mirror protocol gains `SubscribeUrl` / `UnsubscribeUrl` (`{ mirrorId, url }`): a page with no `Client` posts them on the channel, and an `EngineHost` built with `nodes` and `urls` parses, plans and registers the URL's root and edge windows under that `mirrorId` — a thin adapter over the existing `Subscribe` and `SubscribeRelated`, refcounted and swept like any mirror's registrations. `EngineHost`'s `registry` defaults to `nodes.collections`. `ServiceWorkerHost.run` and `ElectedHost.run` forward `nodes` / `urls`; `ElectedHost`'s Client takes `urls` too.
  - `Query.tryPlan(nodes, read)` is `Query.plan` with its `QueryError` as a typed failure.

- b4489c5: Write-path incremental view maintenance. A `mutate` and a push acknowledgement now carry the collections they touch, so a live query observing a different collection no longer re-materialises when an unrelated collection changes; the collections are discovered by running the mutator's local handler through a lightweight collection-tracking writer. The materialised optimistic overlay is cached and shared across observers (invalidated on every journal append/trim and pull), so a single change costs one journal replay rather than one per observer. `LiveView.put`/`del` gain an id index: an absent id is now an O(1) no-op and an existing row is located by binary search on its sort key (O(log n) for distinct sort keys, O(log n + equal-key run) on ties) instead of a linear scan. A checked-in benchmark (`bun run bench`) exercises a mutation burst over a large collection with many observers.

  Targeted overlay-delta recomputation on pull-with-pending remains staged: a pull while the journal is non-empty still falls back to a global rebuild, preserving rebase correctness.

### Patch Changes

- d76b04d: Docs: add the "Coming from TanStack Query / SwiftData / SWR" capability guide
  (`docs/comparisons/coming-from-tanstack-query.md`) and link it from each package README.
- 8995115: `Derive`'s combinators (#114) now consume `observeChanges` directly when a
  leaf is built from a full `ClientView` via `Derive.observed`, instead of
  diffing consecutive `observe()` pages to recover a delta `LiveView` already
  computed (#133 item 1, ADR-0027 §4's flagged follow-up). `Incremental.
deltaFromChanges` reads an `observeChanges` batch's enter/update/exit/move
  decision directly; `observed`'s returned source carries this feed invisibly
  alongside its ordinary page stream, so `filter`/`map`/`join`/`groupBy`/
  `distinct`/`orderedWindow` built on top of it pick it up automatically. A
  source built any other way — a raw `Stream`, `view.observe(subset)` called
  directly, or another combinator's own output — still diffs pages, unchanged.

  No public API changes: `Derive.observed`'s parameter type widens from
  `ClientView.Reader` to accept a full `ClientView.ClientView` too, and every
  combinator's signature is untouched.

- 8995115: `CollectionIndex` acceleration (#113) is no longer bypassed for every
  collection whenever any mutation is pending (#133 item 4): since #109 the
  engine already computes exactly which collections a batch of pending
  mutations touches for the rebase path, and `indexForCollection` now reuses
  that to scope the bypass — a pending mutation on collection A leaves
  collection B's declared/auto-discovered index usable. An unscoped result
  (an unknown mutator, undecodable args) still conservatively falls back to a
  full scan for every collection, same as before. No public API changes —
  `indexes`/`autoIndex` options and query results are unaffected; this only
  changes when the full-scan fallback kicks in.
- cc2f5b7: Observers subscribe to their change hub BEFORE taking the initial
  snapshot (#84). A hub only delivers to live subscribers, so a change
  published while an observer materialized its first page was silently
  lost — and because seq-gap recovery needs a _next_ item to notice the
  gap, a quiet collection never re-emitted: `Related` joins missed foreign
  writes, live queries slept through a mutation that landed in the
  subscribe window. `ClientEngine`'s subset observers and `TabMirror`'s
  key observers now hold the subscription first; a buffered change the
  snapshot already reflects steps as a stale seq or an idempotent
  re-apply.
- a874acb: Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
  packages (no engine API changes; build, typecheck, and the full test suite pass
  unchanged).

  The version is now centralised in a root **Bun catalog**
  (`package.json` → `workspaces.catalog`): every package's `devDependencies`
  reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
  published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
  Every example is a workspace member so they share the same `effect` version
  as the engine instead of pinning its own.

- 454e75c: ADR-0025's read path is reusable outside the protocol carrier (#163).
  `SyncServer.readSubsets(deps, context, request)` is `handleRead` without the
  identity resolution: the filterable check, `SyncMiddleware.onRead`, the
  deny-by-default auth filters, then `Backend.evaluate` + `getRows` per subset;
  `handleRead` calls it, and the derived REST handlers in `@legation/jsonapi`
  call it behind an HTTP request's identity. Every subset of a batch is
  authorized before any is evaluated, as `handleRead` always did, and the rows
  of each subset now come back in the evaluated order (`getRows` promises
  none), so a fallthrough read over a SQL backend is windowed exactly as
  `Subset.apply` orders it. `Query.runVia(fetch, nodes, read)` runs a read over
  an external row source — the plan, `Related.queryVia`'s two phases, and the
  edge windows — and `Query.runPlanVia(fetch, nodes, plan)` does the same over
  an already-compiled plan; `Client.query`'s server fallthrough compiles once
  and uses the latter.
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

- 6e9e119: Differential filter harness (issue #153, ADR-0028).
  - `BackendContract` rule 6 (reference subset semantics) now also runs a small
    generated corpus of predicates, order terms and limits over the contract's
    `rank`/`tag` columns, so every backend inherits the check for every operator
    in the core. This is stricter than before: text order is code-point order,
    so a backend whose text columns carry a locale collation fails the contract
    by design — ADR-0028 requires `COLLATE "C"` (Postgres) or `BINARY` (SQLite).
  - `FilterCorpus` is a new `@legation/effect/internal` export: seeded corpus
    generators over Effect's `Random` service (`Random.withSeed`), a minimiser
    that shrinks a disagreeing predicate/row pair, and a disagreement reporter.
  - `@legation/sql`'s tests gain the differential harness itself: `Predicate.test`
    and `Sql.compileWhere` on SQLite are compared against a Postgres oracle
    running in-process via PGlite, with the known JS divergences pinned until
    #155 closes them.

- a1b95d4: The rune hooks speak Query over the Client (ADR-0022 step 8). `useQuery`/`useAggregate`/`useAggregateGrouped` take declarative `Query.Read` thunks — `include`d edges resolve onto each row's `related` (windowed per the edge's declared order), so `useRelated` is removed; `useMutation`/`useMutationWithAck` run over the context Client. The hooks read a `ClientRuntime` (`ManagedRuntime<Client.Client>`) provided via `setClientRuntime`. `@legation/effect` adds the `Client` service tag and exposes `Client.nodes` (the registry the Client was built from).
- eb9555a: The filter-grammar bridge (ADR-0028 §5, #161): `@legation/jsonapi` now
  translates both ways between effect-jsonapi's filter AST and the engine's
  `Predicate`, parses a JSON:API URL into a `Query.Read`, and encodes the whole
  predicate exactly. Bumps `@thomasfosterau/effect-jsonapi` to ^0.13.0, which
  carries the grammar (`Filter`, `Sort`, `Query.Filter`, `Query.canonical`,
  `Resource.filterable` / `Resource.sortable`).
  - `JsonApiQuery.fromFilterAst(ast)` is total — every grammar node has an
    engine node — and `toFilterAst(predicate)` is partial: `Exists`, an empty
    `In` / `NotIn` list and a `null` literal have no URL form and return `None`,
    so callers fail closed. `foldConstants` folds the two definite cases away
    exactly (an empty `In` is false, an empty `NotIn` true under ADR-0028).
  - `JsonApiQuery.parseRead(nodes, url)` / `parseParams(nodes, collection,
params)` decode `include`, `fields`, `sort`, `page` and `filter` with
    effect-jsonapi's `Query.schema` derived from the **node graph** (each node's
    filterable set — operators and literal kinds — and edges become the codec's
    declaration; `resourcesOf(nodes)` exposes the synthesised resources) and map
    them onto the read: `filter` → `where`, `sort` → `order`, `page[limit]` /
    `page[after]` → `first` / `after`, `include` → edge selects. Include paths
    are single level (ADR-0028 D1). `fields[]` is carried beside the read as a
    projection, never into the plan. Every rejection is a `QueryError` whose new
    `parameter` field names the offending query key (the 400's
    `source.parameter`). A `/{type}/{id}` URL reads as `filter[id]`, first 1.
  - `JsonApiQuery.canonical(nodes, read)` compiles the read and encodes its plan
    through effect-jsonapi's canonical encoder — one string per plan, the
    subscription identity of ADR-0029 — and `parseRead` accepts it back.
  - The encoder is exact: `defaultEncoder` pushes the whole predicate as the
    grammar's canonical `filter[...]` form (operators, `or`, `not`, `isnull`,
    `nin` included — nothing is dropped any more); `safeFilters` is gone. A
    subset whose predicate folds to false is answered without a request, and one
    with no URL form fails closed. `QueryEncoder.encode` now returns
    `Effect<Option<string>, QueryError>`; `JsonApiRequestOptions.filter` is a
    filter AST (`Filter.eq("status", "open")`) instead of a `Record<string,
string>`; query strings are serialised through `Query.serialise` (readable
    `[`/`]` in keys). `buildQueryString` lives in `JsonApiQuery` and stays
    re-exported from `CollectionLoader`.
  - `NodeBridge.fromResource` / `registry` read the filterable set off the
    resource's own declaration (`Resource.filterable` / `Resource.sortable`): an
    attribute keeps its name and derives its kind from its schema; a to-one
    relationship's declaration lands on the edge's key field (`author` →
    `authorId`, kind `text`). The `filterable` / `sortable` options remain as
    per-field overrides (the way to give an `instant` its kind).

- 4fbd0b7: Fix a race in `Related.observeWith` that could leave a live join permanently
  stale: a foreign-row write landing between the join's index priming and its
  foreign observers subscribing was swallowed by the observers'
  initial-emission drop, and nothing re-emitted until the next foreign write.
  The observers' initial current-rows emission is no longer dropped — an
  unchanged rebuild re-hydrates to the same join and dedups away via
  `changesWith`, while a racing write now correctly re-emits.
- bf9054d: Two fixes surfaced by running `verifyBackendContract` over a real SQLite
  executor (the commerce example): `SqlBackend`'s mutation-ledger upsert
  re-bound a placeholder index, which renders an extra unmatched `?` under the
  sqlite dialect (the fake-executor tests never bound params positionally) —
  now `excluded.`-based and dialect-safe. And `verifyBackendContract` no longer
  imposes a value-encoding convention the engine itself doesn't require
  (ADR-0014 keeps values opaque): the idempotency rule checks the
  discriminating field instead of exact value equality, and the evaluation rows
  use a string discriminator instead of a boolean (SQLite has no boolean type).
- e40c73a: `@legation/sql`'s compilers are exact on Postgres and SQLite (ADR-0028 §4 and
  §6, #156): every predicate node compiles to a SQL boolean expression whose
  three-valued result per row equals `Predicate.evaluate`, so the `WHERE`
  returns precisely the rows the JS evaluator returns `Some(true)` for. The
  differential harness proves it against a real Postgres (PGlite) and SQLite
  over the whole generated corpus, set and per-row verdict both. `Sql.ts` no
  longer describes itself as a superset pre-filter.
  - **Literal kinds.** `Sql.compileWhere` and `Sql.compileSelect` take an
    optional `kinds` map (field → `Predicate.LiteralKind`: `text`, `integer`,
    `double`, `boolean`, `instant`) and a `foreignKinds` map (collection →
    kinds) for the inner `where` of an `Exists`. `Dialect` gains
    `textCollation` and `boolean`.
  - **Collation clause.** A `Compare`, `In` or `NotIn` on a field declared
    `text` carries an explicit code-point collation on the column side:
    `"col" COLLATE "C" = $1` on Postgres, `"col" COLLATE BINARY = ?` on
    SQLite. The clause requires the declaration — a string literal alone never
    collates, since it may be bound against a `uuid`, `date`, enum or
    `timestamptz` column. The schema rule stands: declare filterable and
    sortable text columns `COLLATE "C"` (Postgres) or leave them `BINARY`
    (SQLite).
  - **Typed binds.** A literal binds by the declared kind: strings for `text`
    and `instant`, numbers for `integer` and `double`, booleans per dialect. A
    literal of another JS type is a cross-type comparison (rule (d)) and binds
    as `NULL`, so its verdict is unknown exactly as in `Predicate.evaluate`
    and SQLite's affinity coercion never sees it; in a list such literals are
    dropped.
  - **SQLite booleans are `0`/`1`.** The SQLite dialect binds boolean literals
    as `1`/`0` (the `node:sqlite` driver refuses a raw boolean), and
    `SqlBackend` decodes `0`/`1` back to booleans for columns whose new
    `TableMapping.kinds` entry says `boolean`; other columns stay exactly as
    the driver returns them. `SqlBackend` resolves an `Exists` like
    `MemoryBackend` does: NULL foreign values are left out and the rest are
    decoded by kind.
  - `@legation/effect`: `Predicate.LiteralKind` is the one home of the kind
    vocabulary; `FilterCorpus.Column.kind` uses it and the corpus's `"string"`
    kind is renamed `"text"` to match ADR-0028.
