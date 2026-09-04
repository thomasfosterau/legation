# @thomasfosterau/effect-chancery

## 0.2.0

### Minor Changes

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

- 1f4a9ce: Push the journal as one `atomic:operations` request when the server advertises
  the JSON:API Atomic Operations extension (#160). `JsonApiBackendConfig.atomic`
  (`{ path }`) switches `applyMutations` from one `POST`/`PATCH`/`DELETE` per
  mutation to a single all-or-nothing request per batch — `create` → `add`,
  `update` → `update`, `delete` → `remove`, sent with the extension's media type
  — and `JsonApiSync.layer` fills it in automatically when the reflected api has
  an endpoint taking an `atomic:operations` document (effect-jsonapi's
  `Endpoint.operations`); `JsonApiSyncOptions.atomic: false` opts out, `{ path }`
  names the endpoint explicitly.

  Delivery over the atomic path is exactly-once per batch rather than
  at-least-once: the in-session ledger advances only once the server has applied
  every operation. A transient failure (transport, 5xx, or a 4xx naming no
  operation) moves nothing and the client retries the batch; a 4xx error document
  whose `source.pointer` names an operation is a permanent rejection of that
  mutation — it is reported in `rejected`, the batch is resent without it, and
  every mutation is then acknowledged in order (the poison-mutation semantics of
  ADR-0008). Change hints come from the result document's resources. Creates
  keep sending the client-generated `id`; `lid` is supported by the wire format
  but unused until a mutator needs a server-assigned id. The per-request path is
  unchanged and still documented as at-least-once.

  Route reflection now recognises an atomic operations endpoint structurally (a
  request payload with a top-level `atomic:operations` member) and skips it:
  previously `POST /operations` classified as `create` on a phantom `operations`
  resource, which derived a phantom collection and mutator. `Convention` gains
  `reflectAtomic` and `isAtomicEndpoint`; `JsonApiSync.inspect` reports the
  endpoint as `atomic`. Reflected endpoint refs now carry the endpoint's
  `identifier` as their `name` (Effect 4 renamed the field).

  Also: `JsonApiBackendConfig.writes` expresses mutators beyond the derived CRUD
  ones as JSON:API writes (a `Write` is one create/update/delete of one
  resource), which is what lets `BackendContract.verifyBackendContract` run over
  the backend in atomic mode against an effect-jsonapi `Endpoint.operations`
  server; the atomic path rejects mutation-id gaps as the contract requires; and
  `getRows` now omits a row the server answers `404` for instead of failing.

- 6f62539: Auto-subscribe and `include` for relationship resolution.
  - `Relationships.related(engine, subset, names)` is an auto-subscribing
    relational read: it subscribes the base subset and, from its linkage, the
    narrowed `id IN (...)` subsets of each referenced collection, tracking the
    live linkage and tearing the subscriptions down with the scope. Callers no
    longer wire up the related collections by hand. Composes with the query
    encoder so the related subsets narrow server-side via `filter[id]`.
  - `JsonApiSync`/`JsonApiBackend` gain an `includes` option (collection →
    relationship names). Listings then carry `?include=...`, and the compound
    document's related resources are harvested so an auto-subscribed
    `id IN (...)` subset is served from that response — the related rows arrive
    with their parent, no extra round trip.

- 454e75c: Derived REST `list` / `get` handlers over the engine's read path (#163): a
  JSON:API `GET` is ADR-0025's `read` operation with a document body, so the
  REST tier and the sync tier now share one grammar, one evaluator and one auth
  path — the premise of ADR-0029's "same URL, same result".
  - `RestHandlers.make({ nodes, backend, policy, context, middleware?, prefix? })`
    binds handler factories for effect-jsonapi's `Endpoint.list` / `Endpoint.get`:
    `rest.list(resource)` and `rest.get(resource, { notFound })`. Each parses the
    request URL into a `Query.Read` with `JsonApiQuery.parseParams`, resolves the
    request's identity through the `context` seam (HTTP request → `SyncContext`,
    the HTTP analogue of `IdentityResolver`), runs the read through the
    filterable check, the deny-by-default auth filters and `Backend.evaluate` +
    `getRows` with the two-phase include resolution, and serialises the rows.
    Scoping is the policy's alone: an anonymous request to a private collection is
    an empty collection for `list` and a 404 for `get`, as the sync tier's empty
    allow-set behaves. A URL the grammar rejects is the codec's 400 error
    document with `source.parameter`, before any backend call; a collection the
    policy does not declare is a 403; a missing row fails with the endpoint's own
    404 class. Linkage follows the resource's declaration: every
    `Relationship.many` the endpoint's resource declares is resolved — on the
    primary resource and on each included resource's own declaration — because
    effect-jsonapi resource schemas require every declared relationship, and
    nothing the resource does not declare is touched; `include` decides
    `included`. A paginated node edge lists and includes under a
    `Relationship.many` declaration (links plus its rows' linkage in the edge's
    order) and carries links only under `Relationship.paginated`. Derivation is
    opt-in per endpoint, beside hand-written handlers.
  - `DocumentWriter.collection(input)` / `DocumentWriter.data(input)` is the one
    rows-to-document function both the REST handlers and the service-worker façade
    (#164) serialise through: a pure function of the node graph, the read, the
    resolved rows and the `fields[]` projection. Attributes are the node's, `one`
    edges link through their key fields, collection edges through the resolved
    edge rows, paginated edges carry the spec's `links` (and their rows' linkage
    when included); `included` is deduplicated
    with full linkage checked; `fields[type]` projects attributes after linkage;
    `links.self` is the read's canonical string and `links.next` the same query
    with `page[after]` at the last row when the window is full; `linkage` carries
    the edge rows resolved for included resources. Node rows only — `Derive.ts`'s
    `JsonApiRow` has no node graph to plan against.
  - `RestHandlers.queryErrorDocument(error)` renders a `QueryError` as the 400
    document (the codec's own when the rejection was a decoding failure).

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

- a01f775: Make relationship live queries incremental. `Relationships.observe` (and the
  auto-subscribing `related`) now maintain the join instead of re-resolving it on
  every change: the base page is kept current by `engine.observe(subset)` and each
  referenced collection by its own `engine.observe`, so a write to a related row
  re-hydrates the join without re-querying the base, and a base change that shifts
  _which_ collections are referenced re-establishes the referenced observers (via
  `switchMap`). Per-collection lookup indexes are cached and only the changed
  slice is rebuilt; changes that don't move the resolved result are deduped away.

  This also fixes a correctness gap exposed by the now-deduped
  `ClientEngine.observe`: a change to _only_ a referenced collection (e.g. editing
  a comment without touching its issue) no longer fails to update the join.

- 74fe923: Extend the JSON:API sync derivation with server-side query narrowing and
  relationship resolution.
  - `JsonApiQuery`: a pluggable `QueryEncoder` seam that translates a `Subset`
    into a JSON:API query string, with `JsonApiSync` accepting a `queryEncoder`
    override. The shipped default soundly encodes the `eq`/`in` conjuncts and
    `sort` it can express (`filter[field]=…`, `sort=field,-field`) and drops the
    rest; since `Subset.apply` re-runs the full predicate locally, the server
    filter only needs to return a superset. A dedicated JSON:API package can
    supply a richer encoder (operator filters, cursor pages).
  - `Relationships`: resolve JSON:API relationship linkage against the local
    mirror — `resolve`/`hydrate` (pure) plus `query`/`observe` over a
    `ClientEngine`, giving a reactive `related()` (to-one and to-many) that
    re-resolves when a referenced row changes.
  - Engine rows for JSON:API resources are now **flattened** (attributes at the
    top level, `id` and `relationships` reserved) so predicates and `orderBy`
    address attribute fields directly — matching how JSON:API `filter[field]`
    works. Mutator arguments remain structured (`{ id, attributes, … }`).

- fc467ea: Compound documents from the replica (#164): the worker-side caller of the one
  serialiser, so the same URL yields the same document content from the
  replica as from the derived REST handler (ADR-0029 §6).
  - `ReplicaDocuments.make({ nodes, resources?, prefix? })` binds the
    replica-side writer. `fromUrl(view, url)` parses a URL through
    `JsonApiQuery.parseRead` (the read and its `fields[]` projection together),
    runs it over a local view — the replica's rows, optimistic overlay
    included, through the two-phase include with the plan's edge windows — and
    writes a single-resource document for `/{type}/{id}` (`data: null` when
    the replica holds no row) or a collection document otherwise, through
    `DocumentWriter`; `collection(view, parsed)` and `data(view, parsed)` take
    a parsed read. Linkage follows the resource declarations it is given —
    the resources the REST endpoints are declared with, so both sides emit the
    same relationships by construction — or, without any, the node graph's
    synthetic resources (`JsonApiQuery.resourcesOf(nodes)`). Parity holds when
    the endpoint is declared with the node-derived codec
    (`JsonApiQuery.querySchema`) and collection edges are `many`; an `include`
    edge or a `fields[type]` type the bound resource does not declare is
    refused with the codec's `QueryError` shape before any query runs.
    `toCover(read)` names the reads a request needs covered for its document
    to be faithful: the read itself, plus one whole-collection read per
    collection the declared linkage resolves from beyond the read's includes;
    the caller (the façade) serves a URL only when every one is covered
    (`Client.coverageOf`). A collection no bound resource declares is a
    `QueryError` from every entry point, never a defect. The module depends on
    nothing but `effect` and the engine, so it runs in a service worker.
  - `RestHandlers` derives its linkage through the same package-internal
    derivation the replica-side writer uses (what a document's relationships
    are resolved from beside the URL's includes, over any row source); its
    behaviour is unchanged.
  - `JsonApiQuery.parseRead` reports the row id a `/{type}/{id}` path
    addressed (`ParsedRead.id`), so a caller knows to write a single-resource
    document. `JsonApiQuery.invalidParameter` builds the `QueryError` shape
    the codec's checks raise.
  - The commerce example checks every read `src/lib/domain.ts` declares
    against the same seed on both sides, byte for byte
    (`examples/commerce/tests/replica-documents.test.ts`).

- 0cddcc4: `JsonApiSync.layer` accepts a `store` option to back the engine with a
  durable `ClientStore` (IndexedDB, localStorage) instead of the in-memory
  default, so the journal and confirmed rows survive reloads — the happy path
  becomes offline-first with one option.
- b44e9ae: Add convention-first sync derivation from an app's JSON:API `HttpApi`
  (`JsonApiSync`). Point it at an Effect `HttpApi` and it reflects the endpoints,
  classifies them by method + path into JSON:API CRUD roles (`Convention`),
  derives one collection and the create/update/delete mutators per resource type
  (`Derive`), and backs the BYO `Backend` contract with HTTP calls
  (`JsonApiBackend`) — content-hash row versions stand in for the version token a
  plain REST API doesn't expose. `JsonApiSync.layer` composes the whole
  client-direct stack (in-process sync room + client engine) so an existing REST
  API gains optimistic writes, a durable journal, rebase, and live queries with
  no bespoke backend; `JsonApiSync.start` runs the sync loop and polls for remote
  changes.

  Delivery is at-least-once (the in-session ledger has no cooperating server), so
  keep writes idempotent: client-generated ids on create, naturally-idempotent
  PATCH/DELETE.

- ddb1fda: Restructure the repository into a monorepo of sync-engine packages, with package boundaries drawn by dependency footprint:
  - `@legation/effect` — the Effect-native sync engine. Everything that needs only a dependency on `effect`: sync keys, cache stores, the write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, a durable offline outbox, the client/server sync protocol, transports, conflict resolution, the TanStack-Query-style client (queries/mutations/subscriptions/offline sync), the service-worker/edge HTTP cache engine with KeyValueStore persistence, the server-side sync hub with fan-out, and promise facades for non-Effect consumers.
  - `@legation/jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors and query/mutation descriptor builders that plug into the core engine.

- f4f0688: The effect-jsonapi Node bridge (ADR-0022 program step 9): `NodeBridge.fromResource` / `NodeBridge.registry` derive the sync engine's node graph from `@thomasfosterau/effect-jsonapi` resource definitions — one/optional relationships become one-edges with derived key fields, many/paginated relationships resolve their inverses across bridged one-edges, and the `edges` option promotes a foreign-key attribute to an edge so the library's acyclic resource graphs bridge without hand-naming inverses. Bumps the effect-jsonapi dependency to ^0.6.0.
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

- 1b8b120: URL-keyed subscriptions over the mirror channel (ADR-0029 section 2, issue #159).
  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@legation/effect` itself does not know the URL grammar (ADR-0006), so `@legation/jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
  - An explicit pin now registers its edge windows. `Client.subscribe(read)` with `include` holds the foreign windows the read's edges select — `ClientView.pinEdges`, a new member of the view: `Related.trackEdges` (the relational read's reconcile loop without its join) over an owned engine, the relational registration with the host over a connected one — until the last pin releases, and records the edge selects on the ledger entry, so a read with `include` is covered by a pin that declared the edge (ADR-0029 rule 4). The commerce shell's `myCartItems` pin (`include: { variant: true }`) now syncs its edge window. Release stays symmetric with the pin count; the ledger update and the registration it decides are one critical section.
  - A relational registration no longer waits on the network: `Related.relatedWith` (behind `observe` with `include`, `related` and now pins) runs its pulls in the background, one at a time with one queued, so a stalled transport delays rows and never blocks the caller; a failed pull only delays rows (an offline `Client.make` no longer dies).
  - Engine subscriptions are counted where two registrations can hold one window: `ClientView.fromEngine` and `EngineHost` register through `Subscriptions.counted(engine)` — idempotent, so a tab hosting for others (`ElectedHost`) counts once for both fronts — and a relational read's own root subscription ending beside an explicit pin, or one relational read's foreign window beside another's, no longer drops the window from the engine's set-based subscription list.
  - The mirror protocol gains `SubscribeUrl` / `UnsubscribeUrl` (`{ mirrorId, url }`): a page with no `Client` posts them on the channel, and an `EngineHost` built with `nodes` and `urls` parses, plans and registers the URL's root and edge windows under that `mirrorId` — a thin adapter over the existing `Subscribe` and `SubscribeRelated`, refcounted and swept like any mirror's registrations. `EngineHost`'s `registry` defaults to `nodes.collections`. `ServiceWorkerHost.run` and `ElectedHost.run` forward `nodes` / `urls`; `ElectedHost`'s Client takes `urls` too.
  - `Query.tryPlan(nodes, read)` is `Query.plan` with its `QueryError` as a typed failure.

### Patch Changes

- 1ea4723: Add `JsonApiQuery.querySchema(nodes, collection)` and
  `JsonApiQuery.singleRowSchema(nodes, collection)`: the query codecs of a
  collection's `list` and `get` endpoints, as the node graph declares them —
  the codecs `parseParams` and `singleRowParams` decode with — for
  `Endpoint.list(R, { query })` / `Endpoint.get(R, { query })`, so an
  effect-jsonapi endpoint served by `RestHandlers` declares the grammar the
  handler parses (the key-field spelling of a relationship filter,
  `filter[categoryId]`, and `sort=id`).
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
- a874acb: Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
  packages (no engine API changes; build, typecheck, and the full test suite pass
  unchanged).

  The version is now centralised in a root **Bun catalog**
  (`package.json` → `workspaces.catalog`): every package's `devDependencies`
  reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
  published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
  Every example is a workspace member so they share the same `effect` version
  as the engine instead of pinning its own.

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

## 0.1.0

Initial release.
