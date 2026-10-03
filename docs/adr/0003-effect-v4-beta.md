# ADR-0003: Target Effect v4 beta

Date: 2026-06-03
Status: Accepted

## Context

The repository adopted `effect@4.0.0-beta.65` (pinned exactly) before the monorepo restructure. Effect v4 reworks significant APIs relative to v3 (Context.Service, Result vs Either, fork variants, unstable/http modules, Cause reasons) and is the framework's future, but it is a beta: APIs can break between beta releases.

## Decision

Keep targeting Effect v4 beta across all packages, with the version pinned exactly (`4.0.0-beta.65`, no caret) as both peer and dev dependency. Re-evaluate and bump deliberately, package-wide, in a single PR each time.

## Consequences

- We get v4's better ergonomics (yieldable services/errors, ManagedRuntime, unstable/persistence KeyValueStore) and avoid a future v3→v4 migration.
- Production users must accept beta-channel risk; this is documented in each package README ("Targets Effect v4 beta").
- The pinned version means dependabot/renovate won't silently move us; beta bumps are explicit decisions.
- Anything imported from `effect/unstable/*` (HTTP client, KeyValueStore) is double-beta and isolated to adapter/edge modules where practical.

## Update (2026-06-18)

The exact-pin-and-bump-deliberately policy stands; the specific version has moved with it. The pin now lives in the Bun workspace `catalog` (root `package.json`) — currently `4.0.0-beta.83` — which is the single source of truth all packages reference via `catalog:`. The `beta.65` figures above are the original decision's starting point, not the current pin.

## Update (2026-06-19)

Bumped the catalog from `4.0.0-beta.83` to `4.0.0-beta.84`, package-wide in one change per the policy above. The bump was forced by adopting `@thomasfosterau/effect-jsonapi` (ADR-0016), whose peer dependency is `effect >= 4.0.0-beta.84`. All quality gates (build, typecheck, test, lint, format) pass on the new pin.

## Update (2026-09-02)

Bumped the catalog from `4.0.0-beta.84` to `4.0.0-beta.107`, package-wide in one change per the policy above. The bump was forced by moving `@thomasfosterau/effect-jsonapi` to 0.12 (issue #152), whose peer dependency is `effect >= 4.0.0-beta.104`; beta.107 is the version that library develops against, so it was preferred over the later `4.0.0-rc.*` releases. Renames absorbed: `Schedule.either`/`both` → `Schedule.min`/`max`, `Schema.TaggedErrorClass` → `Schema.TaggedError`, `SchemaRepresentation.fromASTs` → `toRepresentations`, and `HttpApiGroup.Any` removed (the `HttpApi` group parameter is now invariant, so the JSON:API entry points became generic). All quality gates (build, typecheck, typecheck:examples, test, lint, format) pass on the new pin.

## Update (2026-09-27): the rc line, and published peers take an open floor

Two changes, both from issue #222 (parent #217).

**Line move.** The catalog moved from `4.0.0-beta.107` to `4.0.0-rc.115`, with every companion `@effect/*` package (`platform-browser`, `platform-node`, `vitest`, `sql-sqlite-node`) at the same exact version, and a root `overrides` entry holding `@effect/platform-node-shared` (which `@effect/platform-node` ranges with a caret) there too, so `bun.lock` carries one Effect line. `rc.115` is the version the applications that consume these libraries move to in lockstep (the website, gardeneria and in-the-dark rc.115 bumps), so the pin tested here is the one they run. `@thomasfosterau/effect-jsonapi` moved to `^0.15.1` in the same change. The rc line ends the beta line: the `beta` dist-tag stopped at `beta.107`, so the weekly canary now follows the `rc` dist-tag.

Renames absorbed: the `SchemaError` module is gone (`Schema.SchemaError` / `Schema.isSchemaError`); `HttpServer`'s address is a `NetAddress.SocketAddress` (`InetAddressV4 | InetAddressV6 | UnixPathAddress`, no `TcpAddress`); `Redis.make` requires a `subscribe` implementation. effect-jsonapi 0.15's `Query.Sort` encodes to `Repeatable` (`string | ReadonlyArray<string>`), and a repeated shorthand `filter[f]` key now decodes as the comma list it spells rather than failing. `@effect/vitest` rc.113 and later require vitest 5, so vitest moved from 4 to 5; vitest 5 replaced the module-level `bench()` with the test context's `bench(...).run()`, and the benchmark files moved with it. Nothing in `effect/unstable/httpapi`, `rpc`, `reactivity`, `persistence` or `sql` needed a source change beyond these.

**Published-range policy.** This part supersedes the original decision's "pinned exactly … as both peer and dev dependency":

- **Published packages peer an open floor**, never an exact version: `"effect": ">=4.0.0-rc.113"`, and the same range on the `@effect/platform-browser` / `@effect/platform-node` peers. An exact published peer is a much stronger claim than a pinned dev catalog; it made the packages impossible to install beside `@thomasfosterau/effect-auth` (`>=4.0.0-rc.112`), because under semver prerelease ordering `rc` sorts above `beta`.
- **The exact version lives in dev only**: the catalog and `bun.lock`. CI resolves that, so builds stay reproducible and a known-good version is recorded. Bumping it stays a deliberate, package-wide change.
- **The floor is shared.** `>=4.0.0-rc.113` is the floor the sibling libraries publish (`@thomasfosterau/effect-jsonapi` 0.15.x, `effect-ai-ext`); effect-auth's `>=4.0.0-rc.112` admits it. Release order is effect-jsonapi → effect-auth → legation, so no repository publishes against a floor its dependencies have not reached. Raising the floor is a negotiated change (effect-auth#207), not a unilateral one.
- **The floor is tested, not asserted.** The gates were run with the catalog at `4.0.0-rc.113` as well as at the `rc.115` pin. Each package README states both.
- **`engines.node`** is declared only on `@thomasfosterau/legation-node` (`">=22"`), the one package that runs only on Node: it peers `@effect/platform-node` and serves the RPC transport over Node HTTP/WebSocket. The range is the intersection of the rc line's own Node floor (`@effect/platform-node` declares `>=18`; `effect` declares none) and what CI runs (Node 22, pinned in `ci.yml` and the release job). Every other package runs in browsers, service workers or workerd as well as Node, and `@thomasfosterau/legation-effect` is pulled into every browser install; since `engines` constrains the Node that runs the package manager, not the target runtime, declaring it there would only reject installs, so it is deliberately omitted.

## Update 2026-10-01 — move to rc.118 and raise the floor (#261)

The catalog, every companion `@effect/*` package and the `@effect/platform-node-shared` override moved from `4.0.0-rc.115` to `4.0.0-rc.118`, and the published peer floor moved from `>=4.0.0-rc.113` to `>=4.0.0-rc.118`. The floor had to rise with the pin because rc.118 removed every `effect/unstable/*` path (the modules became `effect/<x>`, with `httpapi` renamed `http-api`), so source and built `dist/*.d.ts` that import the new paths cannot resolve on an earlier release. Floor and pin are now the same version. `@thomasfosterau/effect-jsonapi` moved to `^0.16.1` and `@thomasfosterau/effect-svelte` to `^0.4.0`, the first releases that peer `effect >=4.0.0-rc.118`. `@effect/language-service` moved from `^0.85.1` to `^0.87.3` (dev-only; no rc line exists). Earlier ADR text that mentions `effect/unstable/*` is historical and left as written.

## Update 2026-10-02 — the scheduled canary is retired (#297)

With Effect 4.0.0 stable, the weekly `effect-beta-compat.yml` canary was removed. Its `latest` leg, which floated onto the newest dist-tag, added nothing over the CI that runs on every `effect` bump PR. Its `floor` leg moved into `ci.yml` as the **Tests (effect floor)** job: on every PR, and blocking, it points the effect-versioned catalog entries at the published floor (`>=4.0.0-rc.118`, so `4.0.0-rc.118`) and runs the test suite (tests only, after the build they need; the full gate set runs at the pin). The "floor is tested, not asserted" rule above still holds. Earlier mentions of the weekly canary are historical.
