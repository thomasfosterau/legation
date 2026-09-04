# @legation/sql

## 0.2.0

### Minor Changes

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

- e68eb3e: New package `@legation/sql`: a driver-agnostic SQL reference
  backend. `Sql` translates a `Subset` predicate to a parameterized `WHERE`
  (SQLite `?` and PostgreSQL `$n` dialects); `SqlBackend` implements the core
  `Backend` contract over a minimal `SqlExecutor` seam (`query`/`run`/
  `transaction`) — subset evaluation, row fetching by id, and a transactional,
  idempotent, gap-checked mutation-id ledger — leaving the driver (`bun:sqlite`,
  `effect/unstable/sql`, `pg`, …) to the app. Addresses the audit's turnkey-backend
  gap (#23).

### Patch Changes

- a874acb: Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
  packages (no engine API changes; build, typecheck, and the full test suite pass
  unchanged).

  The version is now centralised in a root **Bun catalog**
  (`package.json` → `workspaces.catalog`): every package's `devDependencies`
  reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
  published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
  Every example is a workspace member so they share the same `effect` version
  as the engine instead of pinning its own.

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

- bf9054d: Two fixes surfaced by running `verifyBackendContract` over a real SQLite
  executor (the commerce example): `SqlBackend`'s mutation-ledger upsert
  re-bound a placeholder index, which renders an extra unmatched `?` under the
  sqlite dialect (the fake-executor tests never bound params positionally) —
  now `excluded.`-based and dialect-safe. And `verifyBackendContract` no longer
  imposes a value-encoding convention the engine itself doesn't require
  (ADR-0014 keeps values opaque): the idempotency rule checks the
  discriminating field instead of exact value equality, and the evaluation rows
  use a string discriminator instead of a boolean (SQLite has no boolean type).
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
