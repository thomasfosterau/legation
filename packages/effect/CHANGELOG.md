# @thomasfosterau/legation-effect

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
  `aggregateGrouped` store in `@thomasfosterau/legation-svelte`.

  These are local-tier aggregates: they fold the rows a client has already
  synced. A server-evaluated tier that folds the whole collection is explicit
  future work.

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

- d09dc65: `BackendContract.verifyBackendContract` checks that `getRows` reflects a backend's own writes to rows a listing has cached (rule 12, #444). The rule lists a collection so it caches a row, applies an update through the backend, then checks that `getRows` returns the post-write value without a re-list. It then applies a delete and checks that `getRows` omits the row. A backend that caches listed rows and does not bring its cache into line with its own writes now fails `verifyBackendContract`, where it passed before. `MemoryBackend`, `SqlBackend` (SQLite and PostgreSQL) and the atomic `JsonApiBackend` pass the rule unchanged. The rule uses the existing `putRow` and `delRow` contract mutators and the contract's evaluation collection, so a backend registers nothing new. A third-party backend that caches rows must update or evict its cache when it applies its own writes.
- db2366a: `BackendContract.verifyBackendContract` gains two optional options, `restoredLedger` and `restoredPeerLedger`, for a run over a backend restarted on a ledger that already acknowledges the contract's client. They carry the ledger ids the restart expects for the contract client and for rule 11's peer group. The contract first checks that the backend reports exactly the restored id, and fails with a rule that names a forgotten or differing ledger when it does not. It then numbers every rule's mutations from that id. A backend that forgets its ledger on restart now fails the contract when the run passes `restoredLedger`.

  Without the options the run expects a fresh client group, as before: every rule and its expectations are unchanged. Two checks are new on that path: the contract client must report 0 before the first rule runs, and rule 11's peer group must report 0 before it parks its handler. A backend that reports a non-zero ledger for either group on a fresh group now fails with the matching rule.

- 97db489: Backend guarantee 1 now states that mutations from different client groups are serialisable (#353): a handler's reads see a state equivalent to some serial order of the committed mutations, so no committed write is lost to another group's concurrent commit of a row it read.

  `MemoryBackend` meets this. Every row a handler reads from committed state is recorded with its version, and the commit re-checks those versions inside the same state update that applies the writes. If another group changed a row since the read, nothing is written and the handler runs again on the new state. Overlapping calls for one client group behave as before (#346, #355). A handler can therefore run more than once, so its effects outside its writer must be safe to repeat.

  **Action required for custom `Backend` implementations:** `applyMutations` must meet guarantee 1, by a store-wide lock, a commit that re-checks each row the handler read and runs the handler again when one changed, or serialisable isolation on a database. A backend that does not meet it does not conform. The `BackendHandler` contract also now allows a handler to run more than once, so handler effects outside the writer must be safe to repeat. A handler still stale after 16 runs fails with a transient `BackendError` and writes nothing, so the client's retry takes over.

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

  `@thomasfosterau/legation-effect` gains `HintSource`: a small, dependency-free seam that
  publishes `ChangeHint`s to the `InvalidationBus` on a scoped fibre alongside the
  SyncServer. `HintSource.fromStream` lifts a stream of hint batches and
  `HintSource.run` forks a source for the caller's scope. A source that publishes
  value-less hints is matched at the collection level by the existing fan-out
  matcher — sound, because over-matching a poke only costs an empty pull.

  `@thomasfosterau/legation-sql` gains `PollingHintSource`: a tier-2 polling source over the
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

- d675d2e: A push never takes the acknowledged-but-unpulled tail past its bound, and no overlay entry is released early. A push that carries more than half the bound goes out in chunks of half the bound, with a pull before each chunk after the first, and each chunk takes only the room the tail leaves. Overlapping pushes share that room, so the bound holds across them. A push whose tail has no room pulls first, and fails if that pull fails or releases no room. The cost is extra round trips for a large flush, and a push that waits on the pulls between chunks. A pull between chunks that fails or is refused fails the push with a transient `TransportError`, and a chunk that fails fails the push with its own error; the unsent mutations stay journaled for the next push.

  This removes the overflow release, and with it the optional `ClientStore.commitTailRelease` member and its release-record path. Pulls still release the tail through `releaseUnpulled` and the pull's release record. Delete the member: a literal typed as `ClientStore` that still sets it fails to compile (excess property), and one that spreads it has it ignored. That is a breaking change for the interface, so this is a minor bump before 1.0.

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

  For `@thomasfosterau/legation-svelte`, the seam is what lets the same components run over a
  main-thread engine and a service-worker-hosted mirror with zero component
  changes — the Client the hooks read from context is built over either.

- f0348b4: `BackendContract.verifyBackendContract` probes cross-group lost updates (guarantee 1, #353). A new rule 11 parks a handler in one client group after it reads a counter, lets another group increment the same row and commit, then resumes the parked handler. Both increments must land, so the counter must read 2. A backend whose handler read is not validated at commit writes the stale count over the other group's commit and fails the rule. A backend that serialises the two (a lock, or serialisable isolation) passes, whether it orders them or refuses one with a transient `BackendError`, which the harness retries. A backend whose peer call waits behind the parked one passes too: the rule releases the parked handler after a bounded number of scheduler turns, so it does not deadlock.

  The probe runs through a new contract mutator, `BackendContract.countUp` (`contract/count-up`), with args `{ collection, id, gate }`. Its handler reads the counter, calls `BackendContract.park(gate)` between the read and the write, then writes the counter plus one. `park` is a no-op unless the harness has registered `gate`, so a registered handler that never calls it fails rule 11: the probe then has nothing to test. `park` is exported from `@thomasfosterau/legation-effect/internal`, and the gate is named by a string in the args, so the mutation stays serialisable.

  **Action required:** backend authors who run `verifyBackendContract` must register `BackendContract.countUp`, with a handler that reads, calls `park(gate)`, then writes. An unregistered mutator fails rule 11. `BackendContract.memoryHandlers` already includes it. A non-transactional executor (D1-style) does not meet guarantee 1 (#342), so it is not run through this contract.

- a053736: `BackendContract.verifyBackendContract` probes write-then-`BackendError` (#343).
  A new contract mutator, `BackendContract.writeThenFail` (`contract/write-then-fail`),
  writes a row and then fails transiently. The new rule 10 checks that the row keeps
  its value and version, no new row appears, and `lastMutationId` is not bumped, so
  the client's retry applies the mutation again. Guarantee 1 (`Backend.ts`) requires
  this, and `failAlways` does not probe it because it writes nothing first.

  Visibility before the bump is documented in `BackendContract` as a per-backend
  obligation, not a generic rule: the harness cannot observe a backend mid-mutation.

  The unknown-mutator `BackendError` that `MemoryBackend`, `SqlBackend` and
  `JsonApiBackend` raise now carries a typed cause, built by `UnknownMutator.make`
  (`@thomasfosterau/legation-effect/internal`). Rule 10 and rule 4 (`contract/fail`, #382)
  recognise an unregistered mutator by that cause, so a backend that words the message
  differently is still caught. The exact message `Unknown mutator: <name>` stays as a
  fallback for a third-party backend that does not use the helper yet. Rule 4 now also
  needs the probe to fail with a `BackendError`: a `failAlways` that dies with a defect
  fails the rule instead of passing it.

  **Action required:** backend authors who run `verifyBackendContract` (imported from
  `@thomasfosterau/legation-effect/internal`) must register `BackendContract.failAlways`
  and `BackendContract.writeThenFail`. The second is a handler that writes a row and then
  fails with `BackendError`, called with args `{ collection, id }`. An unregistered mutator
  fails rule 4 or rule 10. `BackendContract.memoryHandlers` already includes both. A
  non-transactional executor (D1-style) fails rule 10 by design, since each statement
  commits on its own (#342), so it is not run through this contract.

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

  `@thomasfosterau/legation-svelte`'s `useConnection` (`hooks.svelte.ts`) now retargets
  through this seam for the common case (no `include`d edges, an engine-backed
  view): `loadMore`/`reset` widen/shrink the same open observation instead of
  letting `pages` force a resubscribe. A joined read, or a mirror-backed
  connection, falls back to the original resubscribe-per-page behavior,
  unchanged. No public API changes — `useConnection`'s signature and observed
  behavior (growing window, `hasMore`, `reset`) are the same; only the
  underlying re-registration is gone.

- c856d66: A covered read is judged and answered from one snapshot of its root rows, so a
  pull between the coverage judgment and the answer can no longer serve a root row
  whose edge windows are not pulled yet (#426). `Client.query` and the façade read
  the root once. `Client.coverageOf` takes an optional `{ snapshot }` (the root rows
  already read, with their subset) that the verdict is judged over for that subset;
  `Query.runRows` answers a read from rows already read. A mirror that predates
  `PulledRegistrations` still judges coverage from its registrations alone, so the
  #422 race persists for it until it is upgraded.
- 01a8c64: Coverage by conjunct subsumption with strict windows (ADR-0029 section 3, issue #162). `Client.query` no longer requires an exact subset-hash match to answer from the replica: a read is served locally when some subscription in the Client's ledger covers it. A subscription covers a read when it is on the same collection; its window is absent (neither limit nor cursor), or the read asks for a prefix of the identical window (same order, same cursor, and a limit at most the subscription's when it has one); and, canonicalised to sets of top-level conjuncts, the subscription's set is a subset of the read's (an unwindowed subscription) or the same set (a windowed one, which holds only a window of its own predicate's rows). Every `include`d edge must be among the subscription's edge selects, with a paginated edge's `first` at most the subscription's. `Or` and `Not` subtrees compare structurally as whole conjuncts; nothing is inferred through them, and full implication is not built.

  Behaviour change for the mirror and the owned engine alike: more reads are answered locally. A `Client.query` for a filtered page under an unwindowed subscription of the collection now stays local instead of falling through; under a windowed subscription (the commerce shell's `{ collection: "products", order: ["id"], first: 100 }`) a narrower read still falls through, because the strict window never covers a different predicate, a different sort, a different cursor or an unwindowed read. An explicit pin registers only its root window, so a read with `include` is not covered by it until #159 registers a pin's edge windows. Explicit pins are now counted, so two pins of one root release one at a time. The rule lives in `Coverage` (`@thomasfosterau/legation-effect/internal`), and `Client.coverageOf(read)` reports which subscription covers a read, for devtools.

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
  behind `@thomasfosterau/legation-effect/internal` (read-layer machinery, no new public noun).
  ADR-0027 (client-local IVM delta model) records the two-tier read model and the
  never-widens-sync rule these consume.

- be0a44d: Make the acknowledged-but-unpulled tail durable in `ClientStore` (#336). A push acknowledgement parks the applied mutations in the store, out of the pending journal, so they are never pushed again. Their effects stay overlaid until a pull reports them, and now also across a restart, a hydration snapshot and the BackgroundSync push-only flush. A restart between a push acknowledgement and the next pull no longer shows the confirmed rows without the mutation.

  - **Pull release.** A pull records its whole release in the store before it writes its rows: the watermark, the cookie and the patch. An open that finds the record finishes the pull (it re-applies the patch, which is idempotent, writes the cookie, trims the journal and releases the tail), so a crash at any point shows the pull's effects, never the rows without them. A release that fails part-way is finished in the same process, including one whose record write reports failure after it landed. If that roll-forward also fails after its read of the record, the store seals itself until it is reopened; a failed read alone fails that call and the next write or pull finishes the record.
  - **Row writes during a release.** While a release is outstanding, `putRow`, `delRow` and `clearRows` finish it first, under the same store lock, and fail if they cannot. A failed read of the record fails only that write and seals nothing. Any failure after that read seals the store until it is reopened, and the next open finishes the release. That includes a failed journal trim with no record outstanding: a parked copy left in both the journal and the tail would be double-counted by reads and pushed again. The engine's `seed`, its `clearRows` and its identity reset hold the overlay lock for their row writes. A hydration snapshot finishes an outstanding release before it writes.
  - **Journal and tail.** `appendMutation` refuses an entry the unpulled tail already holds, with a `StoreError` and nothing written: a journal copy of a parked entry would be double-counted and pushed again. `Hydration.hydrate` skips the snapshot's journal entries the store's tail holds, so a hydration never makes that copy. `beginRelease` finishes an outstanding release before it records its own, so a pull is not refused by a release a failed roll-forward left behind.
  - **Identity reset.** The tail is cleared with the rows it was overlaid on, in the store's open-time reset and in the engine's runtime reset. The store drops any release record with it.
  - **Trim.** A push whose journal trim fails leaves the parked entries out of the journal in the same process, as an open does, so they are not pushed again or replayed twice.
  - **Hydration.** `Hydration.SnapshotSchema` gains an optional `unpulled` field. `dehydrate` writes it when the tail is not empty; `hydrate` parks it. A snapshot without the field loads with an empty tail.
  - **Engine option.** `ClientEngine.make` takes an internal `unpulledLimit` (default 1024): the most acknowledged-but-unpulled mutations the overlay keeps (#286); a push never takes the tail past it (#429). Tests lower it to reach the bound quickly.
  - **IndexedDB.** The tail uses the existing key-value layout, so there is no new object store or index and the database version does not change.

  Action required: a custom `ClientStore` must implement six new members: `unpulled`, `parkUnpulled`, `beginRelease`, `releaseUnpulled`, `finishRelease` and `clearUnpulled`. `ClientStore.makeMemory`, `ClientStore.makeKeyValue` and `IndexedDbClientStore` already do. `beginRelease` finishes an outstanding release first, whichever engine on the store began it, and fails when that finish or its read of the record fails. `finishRelease` rolls an outstanding release forward from the record `beginRelease` stored, and a store that cannot do so must fail its later calls, as a sealed store does. `beginRelease` may be a no-op only for a store that cannot survive a restart. In a store that does survive a restart, a no-op `beginRelease` double-counts after a crash mid-release, rather than reverting. Implementing the tail members as no-ops in such a store silently reverts the overlay after a restart: the tail is lost and the confirmed rows lack the acknowledged mutations until the next pull.

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

- 7b21d11: Keep a secondary index in step with the confirmed-row writes that bypass a pull.

  - `reset` (the identity `Reset`) now drops the built indexes along with the rows it clears. An indexed query after a reset could previously consult an index that still named the dropped rows.
  - `Hydration.hydrate` into a store a running `ClientEngine` is built over now tells that engine to re-read: it drops its built indexes and its materialized view, and reveals the result. The re-read runs even when a write fails partway, and it reaches an engine attached while the hydrate was writing. It reaches only engines built over that exact store object. Before, an indexed query could return a row whose indexed field the hydrate had changed, while the row stayed present.
  - A new `ClientEngine.clearRows` (on the `/internal` seam) drops every confirmed row, then the view and the built indexes with them. Use it on a running engine instead of `ClientStore.clearRows`, which left the engine showing the cleared rows.
  - The re-read behind `hydrate` is `ClientEngine.resyncAttachedEngines` on the `/internal` seam. It is internal: app code calls `Hydration.hydrate`, not this.

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

- 792d8f5: Sampling the journal-depth gauge no longer reads the whole journal (#260).
  `ClientStore` gains `pendingCount`, the number of pending journal entries
  without reading them: the memory store takes its journal's length, and the
  key-value store (and so `@thomasfosterau/legation-browser`'s IndexedDB store) counts its
  journal index, reading no mutation bodies. The engine samples
  `legation_journal_depth` from it on every append, acknowledgement and paced
  compaction, where it used to load every pending body to take
  `pendingMutations.length`. A `mutate` also stops reading the journal when the
  overlay cache is warm: the pending snapshot it took is needed only to rebuild
  a cold cache. Custom `ClientStore` implementations must provide
  `pendingCount`, and should count without loading the entries.
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
  - Svelte `useMutationState(mutator?)` rune (`@thomasfosterau/legation-svelte`), reactive
    to a `mutator` thunk like `useQuery`'s `read`.

  The todo example's journal panel is written over this surface,
  replacing its bespoke `Introspection`-based wiring, and demonstrates bounded
  terminal retention.

- c47786c: `@legation/sveltekit` is merged into `@thomasfosterau/legation-svelte` as the
  `@thomasfosterau/legation-svelte/kit` subpath, and `Hydration` moves to the public
  `@thomasfosterau/legation-effect` surface.

  The split was never a dependency boundary: the SvelteKit package contained no
  Svelte code, and its whole `@sveltejs/kit` coupling was two `import type
{ Cookies }` statements — type-only, erased at build. `@sveltejs/kit` is now an
  **optional** peer dependency of `@thomasfosterau/legation-svelte`, so a non-Kit Svelte app
  pulls nothing extra, and only `@thomasfosterau/legation-svelte/kit` needs it.

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
  exported from `@thomasfosterau/legation-effect` (it was behind `/internal`) and speaks
  `Query.Read` instead of `Subset`: `snapshot({ nodes, reads })` and
  `rowsFor(snapshot, nodes, read)`. `@thomasfosterau/legation-svelte/kit` keeps only the
  framework's share — the client-group cookie, a `load`-shaped wrapper, and
  `clientRuntime`, which replaces `engineRuntime` and returns the `Client`
  runtime `setClientRuntime` expects (built on `Client.make`, so it starts the
  sync loop itself).

  Migration: `@thomasfosterau/legation-svelte/Runes` → `@thomasfosterau/legation-svelte`;
  `Runtime.setClientRuntime` → `setClientRuntime`;
  `@legation/sveltekit` → `@thomasfosterau/legation-svelte/kit`;
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
- ddb1fda: Restructure the repository into a monorepo of sync-engine packages, with package boundaries drawn by dependency footprint:

  - `@thomasfosterau/legation-effect` — the Effect-native sync engine. Everything that needs only a dependency on `effect`: sync keys, cache stores, the write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, a durable offline outbox, the client/server sync protocol, transports, conflict resolution, the TanStack-Query-style client (queries/mutations/subscriptions/offline sync), the service-worker/edge HTTP cache engine with KeyValueStore persistence, the server-side sync hub with fan-out, and promise facades for non-Effect consumers.
  - `@thomasfosterau/legation-jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors and query/mutation descriptor builders that plug into the core engine.

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
  (`MemoryBackend`, `@thomasfosterau/legation-sql`'s `SqlBackend`,
  `@thomasfosterau/legation-jsonapi`'s `JsonApiBackend`) already finalizes order/limit/cursor
  locally via `Subset.apply`, this same comparator is the sole ordering
  authority for both client and server — a subset with no declared `orderBy`
  now sorts by id ascending everywhere instead of an unspecified order. The
  collation decision (why this rules out a client-local collation option, and
  what a real one would require) is recorded in
  `docs/adr/0026-subset-ordering-and-collation.md`.

- b4d2b80: Paced mutations (#117): `Paced.debounce`/`Paced.throttle`/`Paced.coalesce`
  (`@thomasfosterau/legation-effect/internal`) pace rapid mutation intents — a text field
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
  `ClientStore.compactPending` (a new store primitive, symmetric to
  `acknowledge` but by explicit id set) only ever removes ids the engine has confirmed are
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
  - `@thomasfosterau/legation-sql`: `Sql.compileWhere` compiles `IsNull` to `IS NULL` /
    `IS NOT NULL` and `NotIn` to `NOT IN (…)` (empty list → `1 = 1`). The
    `BackendContract` corpus now generates NULL, absent and astral text.

- 49fd066: A pull now carries the permanent rejections its watermark covers, so a client whose push response was lost settles the rejected mutation as rejected, not applied (#365). Before, the pull's watermark acknowledged the rejected id as applied, and its effect was dropped with no way to learn the outcome.

  `PullResponse` gains an optional `rejected` list (`{ clientId, mutationId, reason }`), as `PushResponse` already has (#355). The client settles those entries before the watermark acknowledges them. The field is additive: an older client ignores it, and a pull from an older server omits it, so no protocol version changes.

  `Backend` gains a required `rejections(context)` method, which lists the group's remembered rejections with their reasons (Backend guarantee 4). A custom backend must implement it before it upgrades. `MemoryBackend`, `SqlBackend` and `JsonApiBackend` already remember their rejections and implement it. `BackendContract` rule 13 checks that the list agrees with the reported outcome.

- 06405ed: A covered read is answered from the replica only once the windows its rows link to have been pulled (#426). A window is pulled once a pull that started after it was held has applied, or once an already-pulled window covers it. Each window is marked on its own, so a new edge window does not reset the windows already pulled. A read needs the edge windows its root rows link to, and an unpulled window of a sibling key does not uncover a read that links only to other keys. A relational registration whose root is pulled but whose edge windows are not yet held covers nothing. Before its windows are pulled, `Client.query` falls through to the server (offline, it answers locally, as for any uncovered read), and the JSON:API façade forwards the request online and answers `503` offline.

  The pull state is recomputed, not persisted: after a restart each window starts unpulled until a pull lands. `ClientEngine` gains a read-only `pullCounts`; `ClientView.pulled(key)` answers with a per-window summary (`Coverage.Pulled`); `Coverage` gains `pulledFor` and `windowKey`; the mirror protocol gains a host message, `PulledRegistrations`, which an older mirror ignores (it is an addition, and replaces no message). A host now pulls promptly after a plain subscribe, as it already did for named queries.

- a1cea1c: Share the rejection-memory forgetting bound. `floorsOf` (a push's lowest mutation
  id per client) and `forgetBelow` (drop a client's remembered rejections below its
  floor) now live in a new `RejectionMemory` module, exported on
  `@thomasfosterau/legation-effect/internal` for adapter authors. `MemoryBackend` and
  `JsonApiBackend` bound their rejection memory with `forgetBelow`; `SqlBackend` shares
  only `floorsOf` and keeps its own forgetting loop. No behaviour changes.
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

- 652ae7b: The publish of a push's change hints is bounded for every broker now. `makeSerialized` (and `layerSerialized`) bounds a custom `BusBroker`'s `publish` with a new `timeout` option, default 5 seconds, so a hung broker can no longer hold a push's commit-and-publish region open. A timed-out publish is logged and dropped, like the other bus failures. The `FanoutBus` `timeout` option now also documents that a `publish` makes two bounded calls (the broker publish, then a lease registration), and that, on Durable Objects, one broker publish is many shard calls under one bound. The Cloudflare `Room` gains a `publishTimeout` option (default 5 seconds) that bounds its shard calls and lease registrations.
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
- f441941: SSR snapshots over a `ClientTransport`, and a Cloudflare service-binding
  carrier to take them (#211).

  `Hydration.snapshot` no longer requires an in-process `ServerHandler`: pull is
  the correctness path, so subscribe → pull → dehydrate works identically
  against a remote Server. Pass `transport` and the render needs nothing from
  context; omit it and the in-process path is unchanged — a loop-back transport
  over the in-context handler. `loadSnapshot` in `@thomasfosterau/legation-svelte/kit` takes
  the same option, so an Effect-based `load` can render against a backend in
  another Worker.

  `@thomasfosterau/legation-cloudflare` adds `BindingTransport`: the sync protocol over a
  service binding (`env.API.fetch`), for the ordinary two-Worker shape where the
  Worker rendering the page is not the Worker holding the database. It forwards
  the inbound cookie and origin so the bound Worker resolves the same caller —
  and therefore the same room — the browser will reach on its own first pull.
  Getting that wrong is silent: the snapshot still carries the right rows while
  its cookie belongs to another room's CVR, degrading every first pull to the
  reset path. The package's tests pin both sides of it.

- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@thomasfosterau/legation-effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@thomasfosterau/legation-effect/internal` subpath for adapter authors, which the sibling `@thomasfosterau/legation-*` packages now compose from.
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

- fc880dc: Add `Transport.simulateOffline`: a decorator wrapping any `ClientTransport`
  with a toggleable offline gate (push/pull/read fail with a `TransportError`
  while toggled offline, mirroring a real network drop, so the engine keeps
  mutations in the journal and its sync loop flushes them on reconnect).
  Generalises the offline-gate transport the demo examples each hand-rolled
  into reusable substrate — it now
  backs both examples' offline toggle, and `@thomasfosterau/legation-devtools`' actions panel
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

- 439f449: Add `Undo`: an optional, additive undo/redo module layered over anything that
  can `mutate(name, args)` — no engine surgery. It follows the **paired-intents**
  design (the `@rocicorp/undo` shape): the caller supplies both directions of a
  change — an `execute` intent and its reversing `undo` intent — and
  `Undo.make(handle)` returns an `UndoManager` whose `run` / `undo` / `redo`
  replay through the handle's ordinary `mutate` pipeline. A `ClientEngine` and a
  `Client` both satisfy the accepted `MutateHandle` shape structurally; because
  their `mutate` methods don't share an error channel, both `MutateHandle` and
  `UndoManager` are generic in that error type, so a failed mutation is still
  observable as whatever the supplied handle fails with. Because undo and redo
  are just mutations, they are optimistic, journaled, rebased, and offline-safe
  like any write; the module only owns the history.

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

  `@thomasfosterau/legation-svelte` gains `useUndo(manager)` — `canUndo` / `canRedo` as runes
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

  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@thomasfosterau/legation-effect` itself does not know the URL grammar (ADR-0006), so `@thomasfosterau/legation-jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
  - An explicit pin now registers its edge windows. `Client.subscribe(read)` with `include` holds the foreign windows the read's edges select — `ClientView.pinEdges`, a new member of the view: `Related.trackEdges` (the relational read's reconcile loop without its join) over an owned engine, the relational registration with the host over a connected one — until the last pin releases, and records the edge selects on the ledger entry, so a read with `include` is covered by a pin that declared the edge (ADR-0029 rule 4). The commerce shell's `myCartItems` pin (`include: { variant: true }`) now syncs its edge window. Release stays symmetric with the pin count; the ledger update and the registration it decides are one critical section.
  - A relational registration no longer waits on the network: `Related.relatedWith` (behind `observe` with `include`, `related` and now pins) runs its pulls in the background, one at a time with one queued, so a stalled transport delays rows and never blocks the caller; a failed pull only delays rows (an offline `Client.make` no longer dies).
  - Engine subscriptions are counted where two registrations can hold one window: `ClientView.fromEngine` and `EngineHost` register through `Subscriptions.counted(engine)` — idempotent, so a tab hosting for others (`ElectedHost`) counts once for both fronts — and a relational read's own root subscription ending beside an explicit pin, or one relational read's foreign window beside another's, no longer drops the window from the engine's set-based subscription list.
  - The mirror protocol gains `SubscribeUrl` / `UnsubscribeUrl` (`{ mirrorId, url }`): a page with no `Client` posts them on the channel, and an `EngineHost` built with `nodes` and `urls` parses, plans and registers the URL's root and edge windows under that `mirrorId` — a thin adapter over the existing `Subscribe` and `SubscribeRelated`, refcounted and swept like any mirror's registrations. `EngineHost`'s `registry` defaults to `nodes.collections`. `ServiceWorkerHost.run` and `ElectedHost.run` forward `nodes` / `urls`; `ElectedHost`'s Client takes `urls` too.
  - `Query.tryPlan(nodes, read)` is `Query.plan` with its `QueryError` as a typed failure.

- b4489c5: Write-path incremental view maintenance. A `mutate` and a push acknowledgement now carry the collections they touch, so a live query observing a different collection no longer re-materialises when an unrelated collection changes; the collections are discovered by running the mutator's local handler through a lightweight collection-tracking writer. The materialised optimistic overlay is cached and shared across observers (invalidated on every journal append/trim and pull), so a single change costs one journal replay rather than one per observer. `LiveView.put`/`del` gain an id index: an absent id is now an O(1) no-op and an existing row is located by binary search on its sort key (O(log n) for distinct sort keys, O(log n + equal-key run) on ties) instead of a linear scan. A checked-in benchmark (`bun run bench`) exercises a mutation burst over a large collection with many observers.

  Targeted overlay-delta recomputation on pull-with-pending remains staged: a pull while the journal is non-empty still falls back to a global rebuild, preserving rebase correctness.

### Patch Changes

- 56a2e51: With `syncLoop.pushDebounce` set, `ClientEngine.runSync` now auto-pushes a
  mutation journaled at any point after it starts. Previously the push-debounce
  fibre subscribed to the push trigger only once it first ran, a few scheduler
  turns after `runSync` returned. A mutation journaled in that gap, after the
  connect leg had already read the journal, stayed pending until something else
  pushed: another mutation, a reconnect or an explicit `push`. A mutation made
  right after start-up could hit this whether `runSync` is forked (`Client.make`,
  the browser package's `ElectedHost`) or awaited (`ServiceWorkerHost`, the
  JSON:API package's `JsonApiSync`). `runSync` now subscribes before it forks any
  of its fibres.
- d76b04d: Docs: add the "Coming from TanStack Query / SwiftData / SWR" capability guide
  (`docs/comparisons/coming-from-tanstack-query.md`) and link it from each package README.
- 1743c2b: `ClientEngine` settles each mutation once. A push response that repeats a
  permanent rejection the client already holds (the response of a copy that
  loses a race, #355) no longer emits a second `MutationRejected` event or
  resolves a `mutateWithAck` handle twice. A rejection reported for a mutation
  the client has already acknowledged no longer overwrites its `acknowledged`
  state. The first committed outcome the client observed stands: a later,
  contradictory report is logged at debug and ignored.
- 3e29e1b: `BackendContract.verifyBackendContract` gains an optional `awaitPeer` on `@thomasfosterau/legation-effect/internal`. Rule 11 holds a parked handler while the peer group's call runs. A backend whose peer does real I/O (PostgreSQL) can now supply `awaitPeer`, which returns once the peer has finished or is blocked on a lock the parked call holds, so the overlap is reached on every run instead of by scheduler luck (#416). Without it the rule keeps its bounded turn count, so existing callers are unchanged.

  **For third-party backends:** the rule 11 handler is registered under `BackendContract.countUp.name` (`contract/count-up`). It passes `gate` unchanged to `park` between its read and its write, and writes the counter plus one. A handler that omits `park` fails rule 11 with "finished without reaching park()". Only the contract's own handler calls `park`.

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
- ae18cb3: Add a one-sentence doc comment to every exported declaration that had none, so editor hovers on the published `.d.ts` say what each export is for. This covers the root `@thomasfosterau/legation-effect` surface (`Backend`, `Server`, `ClientStore`, the `Predicate` and `Aggregate` constructors, …), its `/internal` seams, and the options and config interfaces of the other packages. The `@thomasfosterau/legation-effect` module header now counts seven concepts (Hydration joined ADR-0022's six). Documentation only; no API or behaviour changes.
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

- c5d3484: README: the `effect` floor (`4.0.0-rc.118`) is now tested on every pull
  request, where CI runs the test suite against it, instead of in a weekly
  canary. The peer range (`effect >=4.0.0-rc.118`) and the tested pin (`4.0.0`)
  are unchanged.
- 454e75c: ADR-0025's read path is reusable outside the protocol carrier (#163).
  `SyncServer.readSubsets(deps, context, request)` is `handleRead` without the
  identity resolution: the filterable check, `SyncMiddleware.onRead`, the
  deny-by-default auth filters, then `Backend.evaluate` + `getRows` per subset;
  `handleRead` calls it, and the derived REST handlers in `@thomasfosterau/legation-jsonapi`
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

- 6e9e119: Differential filter harness (issue #153, ADR-0028).

  - `BackendContract` rule 6 (reference subset semantics) now also runs a small
    generated corpus of predicates, order terms and limits over the contract's
    `rank`/`tag` columns, so every backend inherits the check for every operator
    in the core. This is stricter than before: text order is code-point order,
    so a backend whose text columns carry a locale collation fails the contract
    by design — ADR-0028 requires `COLLATE "C"` (Postgres) or `BINARY` (SQLite).
  - `FilterCorpus` is a new `@thomasfosterau/legation-effect/internal` export: seeded corpus
    generators over Effect's `Random` service (`Random.withSeed`), a minimiser
    that shrinks a disagreeing predicate/row pair, and a disagreement reporter.
  - `@thomasfosterau/legation-sql`'s tests gain the differential harness itself: `Predicate.test`
    and `Sql.compileWhere` on SQLite are compared against a Postgres oracle
    running in-process via PGlite, with the known JS divergences pinned until
    #155 closes them.

- a1b95d4: The rune hooks speak Query over the Client (ADR-0022 step 8). `useQuery`/`useAggregate`/`useAggregateGrouped` take declarative `Query.Read` thunks — `include`d edges resolve onto each row's `related` (windowed per the edge's declared order), so `useRelated` is removed; `useMutation`/`useMutationWithAck` run over the context Client. The hooks read a `ClientRuntime` (`ManagedRuntime<Client.Client>`) provided via `setClientRuntime`. `@thomasfosterau/legation-effect` adds the `Client` service tag and exposes `Client.nodes` (the registry the Client was built from).
- dfb8759: `ClientEngine` now tracks every journal entry it pushes in `mutationStates`, including entries a direct store write put there (`Hydration.hydrate` into a running engine) and entries whose boot-time journal read failed. Each one settles to `"acknowledged"` or `"rejected"` like a locally journaled mutation, so a server rejection of a hydrated entry now emits `MutationRejected`. Before, the entry was pushed but untracked, and a rejection for an untracked id was silently ignored (no event, no state change).

  A hydrated entry is announced like a local one: it emits `MutationJournaled` once, when it is adopted, so its outcome event follows an opening event as it does for a local mutation. The payload is the same `clientId` and `mutationId` the outcome events carry. Re-reading the journal does not announce an entry twice. This adds an event to the stream for hydrated entries, so `registerOnJournal` in `@thomasfosterau/legation-browser` (which listens for `MutationJournaled` while offline) now also registers a background sync for them; it is a consequence of this change, not a change to that package.

  An entry the engine already tracks keeps its phase, and a rejection that contradicts an outcome already observed is logged at warning level and ignored. The journal read that adopts entries now runs under the engine's overlay lock, so a pull's trim cannot land between the read and the adoption.

- 9c9f2b0: Fix a secondary index that could keep pre-pull rows. An index build reads a
  collection's confirmed rows, yields, then installs; a pull whose patch changed
  an indexed field of that collection could land in that window, and the stale
  index was installed and kept until the next rebuild, so indexed queries could
  return rows that no longer match (or miss rows that now do). Each collection now
  carries a generation that every confirmed-row write (and every field-set change)
  bumps; a build discards its result and retries when the generation moved during
  its read, and falls back to a full scan after repeated races.
- ab1fb4e: A refused or failed journal append no longer burns a mutation id (#258).
  `journalHighWater` refusals, quota errors and aborted transactions used to leave
  the id counter one ahead of the journal, so the next mutation carried
  `lastId + 2`, every backend rejected the gap, and the journal never drained.
  `ClientStore` gains `appendNext(draft)`, which allocates the id and appends as
  one store step (the key-value store checks the high-water mark first and
  persists the counter last, healing it from the journal's highest id after a
  crash); the engine journals through it. Custom `ClientStore` implementations
  must provide `appendNext`; `nextMutationId` stays for low-level use but an id
  reserved without an append is a gap.

  An id that has left the journal is never issued again: `acknowledge` and
  `quarantinePending` raise the client's counter to the highest id they remove (in
  the key-value store, before deleting anything), and the key-value `appendNext`
  is uninterruptible. Previously a lost counter write (or an interrupt between the
  index and counter writes) let the next append reissue an acknowledged id, which
  the backend skipped as an idempotent duplicate, silently losing the write. The
  in-memory store's journal writers are now mutually exclusive: `appendMutation`,
  `appendNext`, `acknowledge`, `compactPending`, `nextMutationId`,
  `quarantinePending`, `releaseQuarantine` and `discardQuarantine` all hold one
  permit, so a read-then-write operation can no longer overwrite a concurrent
  append or a released quarantine. `appendNext` heals its counter from the journal
  exactly as the key-value store does, and so does `nextMutationId` on both
  stores.

- eb9555a: The filter-grammar bridge (ADR-0028 §5, #161): `@thomasfosterau/legation-jsonapi` now
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

- 26ad3f3: `ClientStore.makeKeyValue` now drops, when it opens, any journal index entry
  whose body is missing. A crash (or a failed write) part-way through
  `acknowledge` removed the acknowledged bodies but left their index entries,
  which inflated `pendingCount` and the journal-depth gauge, could make the
  `journalHighWater` check refuse appends early, and made `compactPending` refuse
  to renumber over the gap until the next acknowledgement trimmed them. The
  dropped ids stay reserved, so none is reissued, and `pendingCount` still reads
  the index alone.
- cb0a33d: The in-memory `ClientStore` now takes the atomic batch path that the key-value store takes when it has an `AtomicKeyValue`: a pull's release and a push acknowledgement's park and trim each run as one step under the store's lock, with no release record. A release the store refuses now writes nothing, so the unpulled tail keeps its entries and can sit above its bound until the next push acknowledgement or pull releases them, rather than being finished from a record.
- 912d95d: `MemoryBackend` now meets Backend guarantee 1. Each mutation's writes are staged
  until its handler returns, and the staged writes commit with the client's
  `lastMutationId` bump in one state update. A pull or `evaluate` that runs while
  a handler is mid-flight no longer sees its writes ahead of the bump. A handler
  that fails with `BackendError` after a write leaves no write behind, and a
  `MutationRejected` still discards the writes while bumping the id. Handlers
  still read their own staged writes, and row versions are assigned as before.
- 7290d2b: `MemoryBackend` no longer double-applies a mutation when two `applyMutations`
  calls for one client group overlap (a client retry while the first push is
  still in flight). The commit re-checks the client's `lastMutationId`, so a copy
  whose mutation another call already committed is dropped, reported as a replay
  skip, and no longer moves the watermark backwards. The bump also takes the max,
  so `lastMutationId` never falls. `Backend` guarantee 1 now states that calls for
  one client group may overlap and what must hold when they do.
- 41c33e3: `MemoryBackend` now reports the committed outcome from every copy of a mutation. A copy that loses a race to another copy, or replays a mutation already committed, lists it in `rejected` when it was committed as permanently rejected, with the same reason. Before, such a copy reported nothing, so a client could settle a rejected mutation as applied, or show its optimistic effects until the next pull, depending on which push response arrived first. A committed rejection is remembered until the client's next push starts past it, so the backend holds at most that push's unacknowledged rejections per client.
- a77261c: `MemoryBackend` no longer emits a stale value in a push's change hint for a row
  that a later mutation of the same push deleted. A put in an earlier mutation
  left its value in the batch's hint values after a later mutation deleted the
  row, so the hint carried a row that no longer exists and fine-grained fan-out
  routed by it. The delete now removes the row from the batch's values, as a
  delete within one mutation already did.
- bc4c599: Fix a lost-write window in paced compaction (#249 follow-up). Once
  `ClientStore.compactPending` had made a compaction durable (the write-ahead
  intent), a failure applying it (an IndexedDB quota error, an aborted
  transaction) or an interrupt before the engine caught up left the store
  renumbered while the engine, `Paced` trackers and `mutateWithAck` handles kept
  the old ids, so the next paced call dropped the user's newest write. Now
  `compactPending` returns the committed renumbering as soon as the intent is
  durable (the next journal operation, or the next open, rolls the rest
  forward), the store commit and the engine's re-key run uninterruptibly, the
  memory store updates journal and counter together, and `Paced` journals and
  remembers an id in one uninterruptible step.

  Also: a journal found at engine boot or hydrated from a snapshot is frozen
  (never renumbered), since it may already have been pushed; a durable
  compaction reads only the journal index and the bodies it moves instead of the
  whole journal; `dropped` is now a valid phase on the mirror wire (a dropped
  state used to make the whole `MutationStatesUpdate` undecodable); and the
  compaction events are emitted inside the journal lock.

- 20a6e18: Fix paced compaction stranding the journal behind a mutation-id gap (#249).
  `Paced.coalesce`/`debounce`/`throttle` drop superseded unpushed entries, which
  left holes in the client's mutation ids. Both reference backends reject a gap
  (ADR-0008's exactly-once ledger), so every push failed and the journal never
  drained. The client now renumbers: `ClientEngine.dropIfPending` drops the
  entries and renumbers the surviving unpushed ones contiguously, in order, from
  the last entry a push may have sent (or from the first pending id), rewinding
  the id counter to match. The backends are unchanged and still reject gaps.

  - `dropIfPending` now returns `{ dropped, renumbered }` (was the dropped ids),
    and `Paced` applies the moves to every paced instance on the engine so none
    acts on an id that now names a different entry.
  - Safety: compaction never touches an entry a push attempt may have sent. The
    engine records a durable per-client "sent" watermark (`ClientStore.markSent`)
    before each push leaves, so a push whose response was lost keeps its ids
    (renumbering an applied write would get a later one skipped as a duplicate).
    It still refuses while a push is in flight, and runs under the journal lock so
    it is atomic with `mutate` and with a push claiming the pending set.
  - `ClientStore.dropPending` (unreleased) is replaced by `compactPending`
    (drop + renumber + counter rewind, as one step) and `markSent`. The
    KeyValue store does this through a write-ahead intent that is rolled forward
    on the next open, so a crash never leaves a gap, a duplicate or a stale
    counter. Custom `ClientStore` implementations must provide both.
  - `mutateWithAck` handles and `mutationStates` follow renumbered entries, a
    dropped entry's `acknowledged` effect is interrupted instead of leaking, and
    `engineEvents` gains `MutationRenumbered`. `MutationHandle.mutationId` is the
    id at journal time and can change while the entry is unpushed.

- 821b10d: The publish of a push's change hints is bounded by a timeout now that it runs
  inside the uninterruptible commit-and-publish region. A hung broker used to hold
  that region open indefinitely, so a push could never finish. Each broker call the
  bus makes is now bounded: `FanoutBus` (its publish and lease registration, option
  `timeout`), the Redis broker's `XADD` (option `timeout`), and the Durable Object
  `DurableFanoutBroker` (its shard calls, option `timeout`, which aborts the request).
  All three default to 5 seconds. A timed-out call is logged and dropped, the same as
  any other bus failure: a lost poke only delays the next pull, so correctness never
  depends on the bus.
- 9e74a83: A push that takes the acknowledged-but-unpulled tail to half its bound now starts
  a pull ahead of the overflow, so a healthy transport never reaches the bound
  (#337). Before, with no pokes and no `pullInterval`, nothing pulled on its own,
  so a long run of pushes could fill the tail and release its oldest overlay
  entries early, reverting the view until a pull landed. The pull runs in the
  engine's scope and the push does not wait for it; at most one such pull is in
  flight, and a failed one does not block the next.
- e7f4871: A push acknowledgement no longer reverts the view before the pull lands (#286). The push used to trim a mutation's optimistic effects from the overlay as soon as the backend acknowledged it, so an observer saw the pre-mutation value until the next pull. The applied entries now stay overlaid until a pull reports them, and the pull reveals the confirmed row in one change. A permanently rejected mutation still leaves the view at its push, since the backend applied nothing.

  The acknowledged entries are held in memory and bounded at 1024: past that, the oldest are released with a warning. An identity reset clears them. A pull's confirmed rows and its `lastMutationIds` are read as one snapshot, re-reading (up to three passes) when a push commits mid-pull, so, on a backend whose mutations commit their `lastMutationId` with their effects, a pull never leaves out a push its rows carry and an acknowledged mutation is never counted twice. `MemoryBackend` and `SqlBackend` on D1 do not commit them together yet, so a mutation can still be counted twice there until the next pull (#341, #342). Only when a push lands on every pass does a pull report a push its rows lack, which reverts that mutation until the next pull.

- 916d91b: `SyncServer`'s push handler no longer loses a fan-out when it is interrupted.
  The backend commit and the publish of its change hints now run as one
  uninterruptible region, so an interrupt that lands after the commit still
  publishes the hints. Before, an interrupt between the two (a client dropping
  mid-push, say) left the change committed but never poked the other client
  groups, and a replayed retry carries no hints to repair it. The trade-off: a
  slow `applyMutations` can no longer be cancelled mid-push; an interrupt waits
  for the commit and its publish to finish.
- f829146: Rewrite the `@thomasfosterau/legation-effect`, `@thomasfosterau/legation-node` and `@thomasfosterau/legation-browser` READMEs against the current API. The stubs are replaced by install, usage and API sections with examples that compile against the published entry points: the root `Node`, `Query`, `Mutation`, `Client` and `Server` surface, `HttpSyncServer` on Node, and the browser host, store, cache and Background Sync modules. The `@thomasfosterau/legation-effect` package description now names the ADR-0022 surface instead of the v1 vocabulary. Documentation only; no API or behaviour changes.
- 13658a7: The Redis Streams broker (`makeRedisBroker`) resolves each subscription's start position once it succeeds, then reads on from the last entry it saw. A hint published between a block timeout and the next read is delivered: the read continues from a fixed ID (`XREVRANGE ... COUNT 1`, or `0-0` for an empty stream), not from `$`, which would move forward on each read. The `"$"` option keeps its meaning: a subscriber reads only hints published after its start position.

  `subscribe` makes one start-position attempt and waits at most 500 ms for it, then returns either way. So `SyncServer` construction, which subscribes to the bus, waits at most 500 ms when Redis is unreachable. While Redis answers in time, a hint published once `subscribe` returns is never missed. If the attempt fails or times out, the subscription's reader makes the attempt on its first step, and retries each failed step with a back-off of 200 ms, doubling, capped at 5 s, until Redis answers. While Redis is unreachable, a publish that races the start can be missed; delivery stays best-effort (ADR-0009).

  Each outage logs a warning on its first failed step, a debug line for each further retry, and an info line when Redis answers again.

- 31cfb2c: The Redis Streams broker (`makeRedisBroker`) bounds each reader `XREAD BLOCK` at its `block` time plus 2 seconds. A read with no reply by then is logged, backed off and retried from the last ID seen, as a failed start lookup already was, so a connection that accepts a read and never answers no longer parks the subscriber silently. A normal BLOCK timeout (a null reply) is still a success, and `block: 0` is not bounded.
- 4fbd0b7: Fix a race in `Related.observeWith` that could leave a live join permanently
  stale: a foreign-row write landing between the join's index priming and its
  foreign observers subscribing was swallowed by the observers'
  initial-emission drop, and nothing re-emitted until the next foreign write.
  The observers' initial current-rows emission is no longer dropped — an
  unchanged rebuild re-hydrates to the same join and dedups away via
  `changesWith`, while a racing write now correctly re-emits.
- 22f320d: `ClientEngine` runs pulls one at a time. Before, a pull issued while another was in flight did not wait for it, so two pulls could leave with the same cookie and an older response applied last could revert rows and the cookie. Now a pull waits for the pull in flight, and an explicit `pull` resolves once a pull that started after the call has been applied, so a call is never answered from data older than itself. Pokes that arrive during a pull share one follow-up pull. Pulls still run in the caller's fibre, so the caller's context and interruption behave as before.
- bf9054d: Two fixes surfaced by running `verifyBackendContract` over a real SQLite
  executor (the commerce example): `SqlBackend`'s mutation-ledger upsert
  re-bound a placeholder index, which renders an extra unmatched `?` under the
  sqlite dialect (the fake-executor tests never bound params positionally) —
  now `excluded.`-based and dialect-safe. And `verifyBackendContract` no longer
  imposes a value-encoding convention the engine itself doesn't require
  (ADR-0014 keeps values opaque): the idempotency rule checks the
  discriminating field instead of exact value equality, and the evaluation rows
  use a string discriminator instead of a boolean (SQLite has no boolean type).
- e40c73a: `@thomasfosterau/legation-sql`'s compilers are exact on Postgres and SQLite (ADR-0028 §4 and
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
  - `@thomasfosterau/legation-effect`: `Predicate.LiteralKind` is the one home of the kind
    vocabulary; `FilterCorpus.Column.kind` uses it and the corpus's `"string"`
    kind is renamed `"text"` to match ADR-0028.
