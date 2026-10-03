---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-node": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-cloudflare": minor
"@thomasfosterau/legation-svelte": minor
"@thomasfosterau/legation-devtools": minor
---

Bump the pinned Effect version from `4.0.0-beta.84` to `4.0.0-beta.107` across
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
