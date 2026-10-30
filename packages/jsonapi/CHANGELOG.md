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
- c856d66: A covered read is judged and answered from one snapshot of its root rows, so a
  pull between the coverage judgment and the answer can no longer serve a root row
  whose edge windows are not pulled yet (#426). `Client.query` and the façade read
  the root once. `Client.coverageOf` takes an optional `{ snapshot }` (the root rows
  already read, with their subset) that the verdict is judged over for that subset;
  `Query.runRows` answers a read from rows already read. A mirror that predates
  `PulledRegistrations` still judges coverage from its registrations alone, so the
  #422 race persists for it until it is upgraded.
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

- 19cc12d: The JSON:API façade answers the mutation status URL (ADR-0030 §2, #511):
  `GET {prefix}/_legation/mutations/{mutationId}`, the `Location` of every write
  receipt, served from the engine's mutation-state map (new option
  `mutationStates`) and never forwarded. `200` with one `legation-mutations`
  resource (`phase`, `mutator`, `journaledAt`, `settledAt` once settled,
  `reason` only when rejected, `links.self` / `links.resource`); `404`
  `code: "unknown_mutation"` for an id the map does not hold. `Prefer: wait=N`
  holds a pending answer until the mutation settles or `N` seconds pass, capped
  by the new `maxWait` option (default 30 s), with `Preference-Applied: wait=N`.
  New module `MutationStatus` builds the documents.
- aba1401: The JSON:API façade answers a write it cannot journal offline with ADR-0030
  §3's error documents (#512): `400 invalid_document`, `409 type_mismatch` /
  `id_mismatch` and `422 unsupported_relationship` for a malformed or mismatched
  body, each with `source.pointer`; the `503` `offline` document with a second
  error `client_id_required` (`source.pointer: "/data/id"`) for a create without
  a client id, or `not_journalable` (the `MutatorError`'s message) for a
  mutation the engine refuses; the plain `503` `offline` document for
  `Prefer: handling=strict`. Online, the same requests are forwarded untouched.
  Attribute values are never validated by the façade.
- 3362c37: The JSON:API façade intercepts writes (ADR-0030 §1, §3, §5, #510). Given the
  engine's journal seam (`mutate`, the worker engine's `mutateWithAck`), a
  `POST` with a client id, a `PATCH` or a `DELETE` on a reflected write route is
  journaled as the graph-derived CRUD mutation and answered `202 Accepted` with a
  write receipt — the resource as journaled, `meta.legation.status: "pending"`
  and a `Location` naming the mutation status URL — when offline, when the
  forward rejected at the transport, or on `Prefer: respond-async`
  (`Preference-Applied: respond-async`). Online and unasked, writes are
  forwarded unchanged and journal nothing; `Prefer: handling=strict` never
  journals. New options `mutate`, `intentOf` (default
  `FacadeWrites.graphIntentOf(nodes)`), `writes` and `pull`; new
  `FetchHandler.forwarded(request, response)`, which signals `pull` after a
  `2xx` forwarded write.

  **Breaking:** `FetchHandler.offline` is now a function of the request,
  `offline(request)`: a write candidate is journaled and answered with its
  receipt (pass the clone taken before forwarding), anything else gets the 503
  `offline` document as before. Replace `facade.offline` with
  `facade.offline(request)`.

- 2dbbce7: `FacadeWrites.writesOf(nodes, options?)` is the inverse of `graphIntentOf` (ADR-0030 §5, #529): for every graph-derived CRUD mutation (`CrudMutation`, filtered by `writes` as the registry is) it says how the args replay as one JSON:API write, with each `one` edge's `via` key moved out of the attributes into `relationships[edge].data` (`null` linkage when the key is `null`). Pass it as a `JsonApiBackend`'s `writes`, so a node-graph app's journaled `{type}/create`, `{type}/update` and `{type}/delete` reach the server as the `POST`, `PATCH` and `DELETE` the app would have sent.

  The write's `type` is always the mutation's own: args naming another type are refused (`FacadeWrites.InvalidWriteArgs`), and `JsonApiBackend` now reports any `writes` function that throws as invalid args, a `BackendError`, rather than a defect.

- d12e078: Issue #218: the filter grammar (effect-jsonapi's query-parameter format) and
  `Predicate` (legation's own subset language) are two different things, not
  one language with an internal engine form — `CONTEXT.md` and ADR-0016 are
  corrected to say so; ADR-0028, `Predicate`, every interpreter and the
  generated corpus are unchanged.

  `JsonApiQuery.fromFilterAst(ast)` no longer claims to be total and no longer
  throws for a literal outside `string | number | boolean | Date`: it now
  returns `Result.Result<Predicate.Predicate, QueryError>`, so a caller
  bridging a filter AST built over a resource with a richer decoded attribute
  type gets a typed failure instead of an uncaught exception. Its doc comment
  now states the field-namespace precondition (field names are copied
  verbatim, correct only because a caller pre-synthesises a resource whose
  fields are already the engine's) and names the `Date → toISOString()` step
  as a load-bearing encode (ADR-0028 rule e), and states plainly that
  `toFilterAst` is not its inverse. `JsonApiQuery.parseParams` /
  `JsonApiQuery.canonical` are unaffected in observable behaviour: both call
  sites' literals are always wire scalars by construction (decoded through
  the node-derived synthetic resource, or copied from a `Predicate.Literal`),
  so the typed failure is unreachable there — the change makes that
  unreachability an enforced fact instead of an assumption, and gives the
  exported function's own general contract a typed failure instead of a
  thrown defect.

  A new property test exercises the Date encode step directly (the existing
  `FilterCorpus`-generated corpus can never produce a `Date`, since
  `Predicate.Literal` is a closed wire-scalar union, so it could not catch a
  regression there) and checks it against the wire text a resource that
  actually declares a `Date`-decoded attribute would send — the façade/REST
  equivalence obligation of ADR-0029 §6.

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

- f24f45b: `JsonApiSync.layer` keeps the client store and the ledger durable together: a new `keyValueStore` option (the durable `KeyValueStore` the client store is built over) makes the client store default to `ClientStore.layerKeyValue()` over it, and the ledger default to `Ledger.keyValue` over it, so a reload keeps the journal, the acknowledged mutation ids and the remembered rejections (#468). An explicit `store` or `ledger` still overrides its default, and without `keyValueStore` both stay in memory as before. The README and the backend's delivery notes now say that a failed ledger write after a successful server write fails the push: mutations acknowledged earlier in that push stay acknowledged, and the resend re-applies the rest, the same window as a crash.
- 8a6fc54: `JsonApiBackend` takes an optional `ledger` store, so its ledger (the acknowledged mutation ids and the remembered rejections of each client group) survives a restart (#468). `Ledger.keyValue` keeps it in an Effect `KeyValueStore`, and `JsonApiSync.layer` accepts the same option. Without one, the ledger stays in memory as before, and a restart of the backend forgets it: a resent mutation that was already applied looks new, and a permanent rejection can no longer be reported to a replayed copy or a pull. The README documents the restart caveat.
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

  - `@thomasfosterau/legation-effect` — the Effect-native sync engine. Everything that needs only a dependency on `effect`: sync keys, cache stores, the write-through cache engine (read-through, dedupe, stale-while-revalidate, invalidation, events), queries, pagination, mutations with optimistic updates, a durable offline outbox, the client/server sync protocol, transports, conflict resolution, the TanStack-Query-style client (queries/mutations/subscriptions/offline sync), the service-worker/edge HTTP cache engine with KeyValueStore persistence, the server-side sync hub with fan-out, and promise facades for non-Effect consumers.
  - `@thomasfosterau/legation-jsonapi` — the previous `@thomasfosterau/effect-chancery` JSON:API helpers, migrated into the monorepo as a protocol adapter with Effect tagged errors and query/mutation descriptor builders that plug into the core engine.

- e1b8333: `NodeBridge` reads more sync metadata off the resource itself (#220). A `paginated` relationship's edge order comes from its own declaration, `Relationship.paginated(ref, { order })`, so `options.order` is no longer required. Two `@legation/` resource annotations, built with `NodeBridge.syncAnnotations({ inverses, kinds })`, name an inverse edge (`@legation/inverses`) and give a filterable field its literal kind (`@legation/kinds`, for an `instant` stored as text). They survive `Resource.annotate` and `Resource.extend`. `FromResourceOptions` stay as explicit overrides and win over the resource's declaration. A malformed annotation, or a kind for a field the resource does not declare filterable, throws `ResourceBridgeError` when the graph is built.
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

- 49fd066: A pull now carries the permanent rejections its watermark covers, so a client whose push response was lost settles the rejected mutation as rejected, not applied (#365). Before, the pull's watermark acknowledged the rejected id as applied, and its effect was dropped with no way to learn the outcome.

  `PullResponse` gains an optional `rejected` list (`{ clientId, mutationId, reason }`), as `PushResponse` already has (#355). The client settles those entries before the watermark acknowledges them. The field is additive: an older client ignores it, and a pull from an older server omits it, so no protocol version changes.

  `Backend` gains a required `rejections(context)` method, which lists the group's remembered rejections with their reasons (Backend guarantee 4). A custom backend must implement it before it upgrades. `MemoryBackend`, `SqlBackend` and `JsonApiBackend` already remember their rejections and implement it. `BackendContract` rule 13 checks that the list agrees with the reported outcome.

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

- 1b8b120: URL-keyed subscriptions over the mirror channel (ADR-0029 section 2, issue #159).

  - `Client.subscribe` / `Client.unsubscribe` accept a JSON:API URL as well as a `Query.Read`. A Client built with the new `urls` option (`Client.UrlReads`: `parse(url)` and `canonical(read)`) parses the URL, plans the read and canonicalises it, so `subscribe(url)` and `subscribe(read)` of one query — and any non-canonical spelling of the URL (parameter order, a repeated `include` key, an API prefix, a `fields[]` projection) — share one ledger entry keyed by the canonical URL beside the subset hash. A URL the bridge refuses (an unknown collection, an unparsable filter, an undeclared edge) fails with a `QueryError` naming the offending parameter and registers nothing; a Client built without `urls` fails a URL call with a `QueryError`, never a defect. `Client.subscriptions` lists the canonical URLs of the explicit pins for devtools, and `Client.coverageOf` names the covering subscription's canonical URL (`Verdict.url`) while a pin holds it. `Client.make`, `Client.connect` and `Client.fromView` take `urls`; `@thomasfosterau/legation-effect` itself does not know the URL grammar (ADR-0006), so `@thomasfosterau/legation-jsonapi` builds the seam from the node graph: `JsonApiQuery.urlReads(nodes)`.
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
- ae18cb3: Add a one-sentence doc comment to every exported declaration that had none, so editor hovers on the published `.d.ts` say what each export is for. This covers the root `@thomasfosterau/legation-effect` surface (`Backend`, `Server`, `ClientStore`, the `Predicate` and `Aggregate` constructors, …), its `/internal` seams, and the options and config interfaces of the other packages. The `@thomasfosterau/legation-effect` module header now counts seven concepts (Hydration joined ADR-0022's six). Documentation only; no API or behaviour changes.
- d1b01a4: Tested against `effect` 4.0.0 (and the matching `@effect/*` companions); the
  peer floor is unchanged at `effect >=4.0.0-rc.118`.

  `@thomasfosterau/legation-effect` adapts to 4.0.0's stricter, type-only `Schema.brand`:

  - `Node.Id` keeps its signature and runtime behaviour; its internal brand
    identifier is cast to satisfy the new concrete-identifier check.
  - `Node.AnyNode`'s `Id` property is now
    `Schema.Codec<string & Brand.Brand<string>, string>` instead of `Id<string>`.
    4.0.0's `brand<String, B>` is type-only and no longer assignable to a wider
    ``brand<String, `${string}/id`>``, so no concrete `Node<"todos", …>` was
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
- ea200ab: Depend on `@thomasfosterau/effect-jsonapi` `^0.17.0`. A document whose read carries `include` now has an `included` member even when nothing resolved (`included: []`), as JSON:API 1.1 requires of a compound document; a read without `include` still omits it. An effect-jsonapi 0.17 endpoint answers 400 to a `filter[…]` its query schema doesn't declare, so an endpoint served by `RestHandlers` must declare the handler's grammar with `Endpoint.list(R, { query: JsonApiQuery.querySchema(nodes, collection) })`, as documented.
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

- 74d8699: `JsonApiBackend` no longer emits a stale value in a push's change hint for a row that a later mutation of the same push deleted. A create or update in an earlier mutation left its value in the batch's hint values after a later mutation deleted the row, on both the per-resource and the atomic-operations paths, so the hint carried a row that no longer exists. The delete now removes the row from the batch's values, as a delete within one push already does in the other backends.
- 96702f4: `JsonApiBackend` change hints now carry `oldValues`: each row an update or
  delete touches is hinted with its value before the push, as `MemoryBackend`
  does, so topic-derived fan-out (ADR-0023) pokes the windows a row moved away
  from. A REST API keeps no change token, so the old value is read: each update
  or delete makes one `GET /{type}/{id}` before its write, once per row per push,
  on both the per-resource and the atomic path. That is one extra request per
  update and delete. A row the push creates has no old value. A read that fails
  fails the push, transiently or refused: a 404 or other 4xx included, so no update
  or delete is sent without its old value. On the atomic path nothing has been
  written by then, so the retry reads again. On the per-resource path the writes
  before the failed read have already applied, so their hints are lost, as with any
  transient write failure there.

  A create or update's hinted value is now the server's returned document whenever
  it sends one (the per-resource path used to ignore it), else the row read before
  the push merged with the write, so a partial PATCH hints the full row.

  Fix: a hinted create or update's relationships were the request's raw JSON:API
  `{ data }` form. They now use the linkage shape `toRow` gives a server document
  (`{ type, id }`, an array, or `null`), the shape listings and stored rows use, so
  a hint matches the row it describes.

- 4230ed5: `JsonApiBackend` keeps its row cache current with its own writes, so `getRows` no longer serves a row a push has updated or deleted at its pre-push value. After an applied create, update or delete, the cache holds the row's value after the write (the server's returned document when it sends one), or no row after a delete. Before this, a row a listing had cached was served from the cache until the next listing.
- f1d0232: A per-resource push (no `atomic` endpoint) now refuses a mutation-id gap with a `BackendError` before it sends any write, as the atomic path already did. Before, a push could acknowledge a later mutation while an earlier one was never applied.
- 159997a: `JsonApiBackend` now fails the push when the pre-write read of an update or
  delete does not return a row. A 4xx, a 404 included, fails the push the same way
  a 5xx, timeout or transport error does: a `BackendError`, with nothing written on
  the atomic path. A 2xx whose document names no resource fails it too. Before, a
  refused read went ahead with no `oldValues` for that row. Every update or delete
  now carries its old value or is not sent. A row the push creates is not read
  unless the server refuses that create, so a 404 on it cannot fail an applied
  create.

  The cost is accepted: a row the server refuses to read stalls that client's
  queue until the read can succeed or the client is reset. Deleting a row that is
  already gone therefore fails with a 404 on every retry, where it used to be
  acknowledged as a no-op. The failure reaches the client as a `TransportError`,
  is retried by the client's retry policy, then surfaces as a `SyncFailure` with
  `operation: "push"`. The in-session ledger belongs to one backend instance, so
  after a restart an already-applied delete is sent again and stalls the same way.
  A create the server refuses for a reason other than a conflict (a 422, say)
  stalls the queue the same way when a later update or delete in the same push
  touches that row, since the row is absent and its read finds a 404.

  On the atomic path, a create the server refuses, followed by an update or delete
  of the same row in the same batch, now reads that row once the refusal arrives,
  before the batch is resent, so the later write carries the row's pre-push value.
  The read follows the same rule as any other: a failed read fails the push with
  nothing written.

  A resource that receives updates or deletes but has no `getOne` route now fails
  any push containing one of those writes (one whose args decode) before any write
  in that push is sent, instead of logging a warning and proceeding without
  `oldValues`. A mutation whose args do not decode is still refused at its turn, as
  before: on the per-resource path the writes before it are delivered.

- 3be5abc: `JsonApiBackend` remembers the permanent rejections its in-session ledger has made, so a replayed copy of a rejected mutation lists it in `rejected` with the same reason, as Backend guarantee 1 requires (#366). Before, the copy was skipped with no outcome, so a client whose push response was lost settled the rejected mutation as applied. A push forgets the rejections below its lowest id per client, as `MemoryBackend` does. The ledger is in-session, so the memory lasts as long as the backend instance.
- b4a9656: Correct the account of what effect-jsonapi 0.15 changed in URL parsing (the
  `effect-rc-floor` changeset mentioned only `filter`). Every comma-list query
  parameter the façade, `JsonApiQuery.parseRead` and the REST handlers decode
  now accepts the repeated-key spelling instead of answering 400: the shorthand
  `filter[f]`, `sort`, and `fields[TYPE]`. Each repeated
  form, and any mix of repeated and comma forms, decodes to the same read as
  the single comma list (`?sort=-name&sort=id` ≡ `?sort=-name,id`,
  `?fields[products]=name&fields[products]=description` ≡
  `?fields[products]=name,description`). Positions that take exactly one value still reject a repeated key with a 400:
  `page[...]`, a scalar operator such as `filter[f][gt]`, and the group form's
  `[conjunction]` / `[path]` / `[operator]`. Encoding is unchanged: always the canonical comma
  form.
- a1cea1c: Share the rejection-memory forgetting bound. `floorsOf` (a push's lowest mutation
  id per client) and `forgetBelow` (drop a client's remembered rejections below its
  floor) now live in a new `RejectionMemory` module, exported on
  `@thomasfosterau/legation-effect/internal` for adapter authors. `MemoryBackend` and
  `JsonApiBackend` bound their rejection memory with `forgetBelow`; `SqlBackend` shares
  only `floorsOf` and keeps its own forgetting loop. No behaviour changes.
- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@thomasfosterau/legation-effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@thomasfosterau/legation-effect/internal` subpath for adapter authors, which the sibling `@thomasfosterau/legation-*` packages now compose from.
- 97cc5f9: Build with `vp pack` (tsdown) instead of `tsc --build`. Each entry point is now one ESM bundle with one declaration file (the two `@thomasfosterau/legation-effect` entries share a chunk, so a value reached through `.` and `./internal` is still one instance). The `exports` map, entry file names and published dependency and peer ranges are unchanged, and nothing from npm is bundled. The source also moved to the Effect lint presets' idioms (namespace imports from `effect/*` submodules, `effect/Predicate` guards, tag-exact error recovery); behaviour is unchanged.
- Updated dependencies [2a1f63c]
- Updated dependencies [ef59fa7]
- Updated dependencies [56a2e51]
- Updated dependencies [d09dc65]
- Updated dependencies [db2366a]
- Updated dependencies [97db489]
- Updated dependencies [cc67999]
- Updated dependencies [a94df19]
- Updated dependencies [d76b04d]
- Updated dependencies [6f53fb1]
- Updated dependencies [d675d2e]
- Updated dependencies [1743c2b]
- Updated dependencies [1c56914]
- Updated dependencies [615e792]
- Updated dependencies [c8d9afc]
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
- Updated dependencies [3362c37]
- Updated dependencies [62dcb1c]
- Updated dependencies [be4be06]
- Updated dependencies [ae18cb3]
- Updated dependencies [be0a44d]
- Updated dependencies [cc2f5b7]
- Updated dependencies [e818dc4]
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
- Updated dependencies [52c614f]
- Updated dependencies [94d6327]
- Updated dependencies [91f07db]
- Updated dependencies [6e9e119]
- Updated dependencies [6c2c802]
- Updated dependencies [ebcc6aa]
- Updated dependencies [a1b95d4]
- Updated dependencies [c105fbf]
- Updated dependencies [e1a028a]
- Updated dependencies [dfb8759]
- Updated dependencies [9260efb]
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
- Updated dependencies [8c65627]
- Updated dependencies [26ad3f3]
- Updated dependencies [cb0a33d]
- Updated dependencies [912d95d]
- Updated dependencies [7290d2b]
- Updated dependencies [41c33e3]
- Updated dependencies [a77261c]
- Updated dependencies [c47786c]
- Updated dependencies [501b12c]
- Updated dependencies [7f1efac]
- Updated dependencies [a04918b]
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
- Updated dependencies [47f4e15]
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
- Updated dependencies [20e57d3]
- Updated dependencies [f010749]
- Updated dependencies [bf9054d]
- Updated dependencies [e40c73a]
- Updated dependencies [f441941]
- Updated dependencies [a01f43b]
- Updated dependencies [9a6426b]
- Updated dependencies [97cc5f9]
- Updated dependencies [fc880dc]
- Updated dependencies [e34bc24]
- Updated dependencies [0470e1c]
- Updated dependencies [439f449]
- Updated dependencies [3a88118]
- Updated dependencies [1b8b120]
- Updated dependencies [cf48723]
- Updated dependencies [b4489c5]
  - @thomasfosterau/legation-effect@0.2.0

## 0.1.0

Initial release.
