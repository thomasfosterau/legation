# @thomasfosterau/legation-svelte

## 0.2.0

### Minor Changes

- e9c5cac: Async Svelte support and a type-safe runtime context. Every live rune hook's
  result gains an awaitable `promise` alongside `current`: pending until the
  first data arrives (suspending a `<svelte:boundary>`'s `pending` snippet),
  then an already-resolved promise replaced per emission and on input change —
  awaiting expressions re-run with fresh rows while Svelte keeps the previous
  UI on screen; stream failures reject into the boundary's `failed` snippet.
  The runtime context is built on Svelte's `createContext`, which raises the
  package's Svelte peer requirement to `>=5.40`.
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

- 41815c6: `useConnection` — connection-style paging over a read's root window (ADR-0024). `loadMore` widens the one window a page at a time rather than fetching detached pages, so each page's rows accumulate, the previous ones stay on screen through the widen (stale-while-revalidate), and the engine only ever syncs the current window — never the whole collection. The hook returns the live rows (`current`/`promise`) plus `loadMore()`, reactive `hasMore` and `loading`, and `reset()`, and seeds from SSR like the other `use*` hooks.

  Per-parent paging falls out of instantiating the hook per parent: scope the read's `where` to a parent id and give each parent its own `useConnection` (one per `{#each}` row), and each parent's list pages independently. The passed read's own `first`/`after` are ignored — the hook owns the window — and the read thunk stays reactive, re-basing to the first page when its base changes.

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

- a1b95d4: The rune hooks speak Query over the Client (ADR-0022 step 8). `useQuery`/`useAggregate`/`useAggregateGrouped` take declarative `Query.Read` thunks — `include`d edges resolve onto each row's `related` (windowed per the edge's declared order), so `useRelated` is removed; `useMutation`/`useMutationWithAck` run over the context Client. The hooks read a `ClientRuntime` (`ManagedRuntime<Client.Client>`) provided via `setClientRuntime`. `@thomasfosterau/legation-effect` adds the `Client` service tag and exposes `Client.nodes` (the registry the Client was built from).
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

- bc76e11: Every rune hook that takes a read thunk (`useQuery`, `useConnection`, `useNamedQuery`, `useAggregate`, `useAggregateGrouped`) lets the thunk return `undefined` to opt out — "no read right now," for a read keyed on a selection that starts empty. No window is registered and no request is issued, and `current` stays at its initial state rather than becoming a `Success` over zero rows, so an opted-out read stays distinguishable from one that legitimately matched nothing. The thunk stays reactive either way: flipping the condition subscribes/unsubscribes with the same stale-while-revalidate behaviour as any other input change.

  This replaces the sentinel-argument workaround (a read keyed on `id ?? ""` to make it match nothing) — the Northwind orders screen and the Conduit editor example both drop theirs in favor of returning `undefined`.

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

- 9af9947: New package `@thomasfosterau/legation-svelte`: idiomatic Svelte bindings. `setClientRuntime`
  supplies the `ManagedRuntime` carrying the `Client`; the rune hooks
  (`useQuery` / `useConnection` / `useNamedQuery` / `useAggregate` /
  `useAggregateGrouped` / `useMutation` / `useMutationWithAck` /
  `useMutationState` / `useUndo`) are the whole read/write surface, each taking
  its inputs as a thunk so a read re-subscribes when the reactive state it
  touches changes. Extends the framework-bindings coverage (#25) to Svelte.
- a69a914: Add a `related` store: a live join over a subset's declared relationships
  (`Related.observe` bridged to a Svelte `Readable`), replacing the hand-rolled
  `relatedStore` pattern in the Svelte examples. The base and foreign
  collections must already be subscribed — the store reads the mirror.
- 5ced720: Add a rune-based API for Svelte 5 at `@thomasfosterau/legation-svelte/runes`: `useQuery`,
  `useNamedQuery`, `useAggregate`, `useAggregateGrouped`, `useRelated` (with an
  auto-subscribing `subscribe: true` variant) and `useMutation` /
  `useMutationWithAck`. Hooks take their inputs as thunks tracked by `$effect`,
  so a query re-subscribes when its reactive inputs change (e.g. a `$state`
  pagination cursor) — something the store API cannot express — and expose a
  reactive `current` `AsyncResult` with stale-while-revalidate `waiting`
  semantics, matching the engine's reactivity atoms and the React binding.
  Every live hook accepts `{ initial }` to seed a synchronous `Success` before
  the first emission — what SSR renders, and what makes the first client render
  match the server markup. The store API on the package root is unchanged and
  remains Svelte-4 compatible.
- 4b05d55: SvelteKit integration (ADR-0020), on the `@thomasfosterau/legation-svelte/kit` subpath.
  `clientGroupId` reads-or-mints the browser's client-group cookie;
  `loadSnapshot` resolves it and produces the page's SSR snapshot over a
  request-scoped engine inside any Effect-based `load`; `clientRuntime` boots the
  Client over a snapshot-hydrated durable store (`Hydration.hydrateIfEmpty`) and
  yields the runtime `setClientRuntime` consumes.

  `@sveltejs/kit` is an optional peer dependency and appears only as a `Cookies`
  type, so a non-Kit Svelte app pulls nothing.

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

### Patch Changes

- d76b04d: Docs: add the "Coming from TanStack Query / SwiftData / SWR" capability guide
  (`docs/comparisons/coming-from-tanstack-query.md`) and link it from each package README.
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

- c5d3484: README: the `effect` floor (`4.0.0-rc.118`) is now tested on every pull
  request, where CI runs the test suite against it, instead of in a weekly
  canary. The peer range (`effect >=4.0.0-rc.118`) and the tested pin (`4.0.0`)
  are unchanged.
- 63bc424: Require `@thomasfosterau/effect-svelte` >= 0.3.2, which ships a `svelte` export condition. Consumers no longer need the manual dual-svelte workarounds — vite-plugin-svelte now auto-detects effect-svelte as a Svelte library and shares the app's single copy of svelte. The commerce example drops its `optimizeDeps.exclude` / `ssr.noExternal` for effect-svelte accordingly (verified in a real dev-server browser run: no `lifecycle_outside_component`). Vitest still needs its `server.deps.inline` — that's a vitest node-module externalization concern, independent of the export condition.
- d24594e: The rune hooks and the engine runtime context are now built on `@thomasfosterau/effect-svelte` (^0.3.1): `useLiveStream` replaces the hand-rolled `$effect`/fiber plumbing behind every `use*` hook, and `createRuntimeContext` provides the typed context behind `setClientRuntime`/`getClientRuntime`. Hook APIs are unchanged. One semantics refinement: an `initial` seed now starts as a **non-waiting** `Success` (no spinner over server-rendered content) until the first live emission replaces it; re-subscription stale-while-revalidate behavior is unchanged.
- a01f43b: The public surface is the six concepts (ADR-0022 step 10b). `@thomasfosterau/legation-effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@thomasfosterau/legation-effect/internal` subpath for adapter authors, which the sibling `@thomasfosterau/legation-*` packages now compose from.
- b1be47b: Support SvelteKit 3: the optional `@sveltejs/kit` peer widens from `^2.0.0` to
  `^2.0.0 || ^3.0.0`. `@thomasfosterau/legation-svelte/kit` uses Kit only as the `Cookies` type
  and always sets the client-group cookie's `path` explicitly (default `"/"`), so
  it behaves the same on both majors; none of the APIs Kit 3 removes or moves
  (`$app/paths` `base`/`assets`/`resolveRoute`, `$app/stores`, `$service-worker`,
  `goto` options, the navigation and form type moves) are used. Tested against
  Kit 3.0.1 (the package's dev pin, and the example apps) and Kit 2.69.1 (the
  package suite run with its dev pin moved back to Kit 2).
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
