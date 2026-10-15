# @thomasfosterau/legation-devtools

## 0.2.0

### Minor Changes

- fc880dc: Ship `@thomasfosterau/legation-devtools` (#120): a devtools panel over the introspection
  substrate — journal & mutation timeline, subscriptions & collections (with
  row counts and the pull cookie), a sync activity log, and actions (force
  pull/push, a simulated-offline toggle, drop a subscription, and a destructive
  clear-store behind a confirm).

  Architecture: a framework-agnostic headless core built entirely over
  already-public substrate (`Introspection`, `ClientEngine.mutationStates`,
  `engineEvents`/`syncFailures`, `ClientStore`), with thin per-framework panels
  — `@thomasfosterau/legation-devtools/react` and `@thomasfosterau/legation-devtools/svelte` — as separate,
  lazily-loadable entry points so an app that never imports them pays nothing
  for the panel in production. This is a functional first cut: plain, legible
  markup; visual polish is deliberately out of scope.

  Scoped to the owned-engine case (an app that constructs its own `ClientEngine`

  - `ClientStore` in-process); attaching over the mirror seam needs a
    mirror-protocol introspection extension, tracked separately (#136).

  Demonstrated in `examples/northwind`.

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

### Patch Changes

- 7b21d11: The `clearStore` action now clears through the running engine (`ClientEngine.clearRows`). It previously cleared the store directly, so the engine's view kept showing the cleared rows until something else invalidated it.
- 99edbe2: Correct the package description: the devtools ship one framework panel, the Svelte one on `@thomasfosterau/legation-devtools/svelte`. There is no React panel.
- 40d28f3: Fix the types of the `@thomasfosterau/legation-devtools/svelte` entry in the published
  package. `svelte/store.ts` and `DevtoolsPanel.svelte` (shipped as source)
  imported their `DevtoolsCore` types from `../src/Devtools.js`, which is not in
  the tarball, so a consumer's type check couldn't resolve them. They now import
  them from `@thomasfosterau/legation-devtools`, the package's own root entry.
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
