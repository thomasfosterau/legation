# Contributing to legation

legation is a pnpm 11 + [Vite+](https://viteplus.dev) (`vp`) workspace on Node 22 or later. This file covers setup, the commands, and the branch, pull-request and changeset rules. The package table is in [README.md](README.md#packages). The conventions, the pitfalls and the ordered gate list live in [AGENTS.md](AGENTS.md); they apply to everyone, not only agents. See [Common pitfalls](AGENTS.md#common-pitfalls), [Conventions](AGENTS.md#conventions) and [Verification](AGENTS.md#verification).

## Setup

```bash
git clone https://github.com/thomasfosterau/legation.git
cd legation
corepack enable   # or any pnpm 10+, which switches itself to the pinned pnpm 11
pnpm install
```

`pnpm install` also installs the Vite+ git hooks and runs `prepare`, which patches the native TypeScript compiler and Oxlint with `@effect/tsgo` so Effect diagnostics fail the type gate.

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

Two workspace mechanics:

- Packages import each other by published name (`@thomasfosterau/legation`); pnpm links the workspace packages, and `pnpm pack` rewrites the `workspace:` and `catalog:` specifiers when a package is published.
- `vp run build` builds the packages in dependency order (`vp pack`, one task per package); the tests resolve the package names to `src/` through aliases in the root `vite.config.ts`, so tests never need a prior build. The example apps and the commerce browser test consume `dist/`, so `vp run test` builds first.

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. CI uses `vp install --frozen-lockfile`.
- `vp run ci` — every gate, in [AGENTS.md "Verification"](AGENTS.md#verification)'s order, stopping at the first failure: exactly what CI runs. The individual commands follow.
- `vp check` — format + lint (Oxfmt + Oxlint, with the Effect presets). Lint is type-aware through oxlint-tsgolint (`typeAware` + `typeCheck` in `vite.config.ts`); tsgolint types each file under its nearest `tsconfig.json`, which is why each `src/__tests__/` (and `packages/devtools/svelte/`) carries one extending `tsconfig.check.json`. `vp check --fix` / `vp fmt` fix what they can.
- `vp run build` — `vp pack` → every package's `dist/`, in dependency order.
- `vp run pack:check` — packs every publishable package with `pnpm pack` and fails on a `workspace:` / `catalog:` specifier left in a packed `package.json`, an internal range that doesn't match the dependency's version, an exact `effect` / `@effect/*` peer, a `svelte` export condition naming a file that isn't packed, or a `publint` (strict) or `attw` (ESM-only: `node10` and `node16-cjs` ignored) finding. Fix a finding; suppress one only in `attwSuppressions` in `scripts/pack.mjs`, with its reason. No registry access.
- `vp run check` — the type gate: packages and tests in one native, Effect-patched `tsc` program (`tsconfig.check.json`). `vp run check:examples` — each example app's own `tsc` / `svelte-check`, against the built `dist/`.
- `vp run test` — every Vitest project (`node`, `jsonapi`, `alchemy-cloudflare`, `auth`, `commerce-browser`, `svelte`); builds first. `vp test run packages/<name>` runs one package's tests without a build. The commerce browser test needs Chromium (see [Tests](#tests)).
- `vp run test:coverage` — the suite plus `coverage/coverage-final.json`, the map `fallow audit` reads.
- `vp run ci:chromium` — installs the Chromium revision `playwright-core` expects, with its system libraries (`--with-deps`; on Linux it runs `apt-get`, through `sudo` when you are not root).
- `vp run bench` — the `*.bench.ts` benchmarks (not a gate).
- `vp exec fallow audit --base origin/trunk` — the fallow gate (see "Fallow local gate" in [AGENTS.md](AGENTS.md#fallow-local-gate)). `vp exec fallow dead-code`, `vp exec fallow dupes` and `vp exec fallow health` run the individual analyses.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of a bare `pnpm` script). The sanctioned non-`vp` invocations: `pnpm install`, `pnpm changeset`, `pnpm audit`, `pnpm exec playwright-core install chromium`, and `pnpm run version` / `pnpm run release` on the release path. Single-check variants are in [Running individual checks](#running-individual-checks).

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Add a changeset (`pnpm changeset`) for every user-facing or package-impacting change, naming each package it touches; a doc-comment change that reaches the emitted `.d.ts` takes a `patch`. Docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "chore: version packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
- Use the `gh` CLI for GitHub operations. Dependabot's pull requests are assigned to the owner by `assignees:` in `.github/dependabot.yml`.

## Adding a package

A new package adds:

- a row in the root `README.md` package table;
- its own `AGENTS.md` (boundary, invariants, terms), a `CLAUDE.md` that imports it (`@AGENTS.md`), and a `vite.config.ts` (`packageConfig` from `vite.package.ts`);
- a `.fallowrc.json` entry, zone and rule;
- an alias in the root `vite.config.ts` and a `paths` entry in `tsconfig.check.json`;
- its name in the root `vite.config.ts` `packages` list (the `build` aggregate).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format with fixes, then lint without fixes, on the staged files: with type-aware lint on, a lint autofix at commit time would make the commit differ from the tree you verified). There is no pre-push hook: run the gates yourself.

## CI expectations

[ci.yml](.github/workflows/ci.yml) is the one CI workflow, on every pull request, every push to `trunk` and on demand. Its `ci` job is a matrix over Node.js `lts` and `latest` (Vite+'s aliases: the newest LTS and the newest stable release; `latest` skips pre-releases), named "ci (node lts)" and "ci (node latest)"; each leg sets up Vite+, runs `vp install --frozen-lockfile` and then `vp run ci`, so CI runs exactly the local command. The legs carry the PostgreSQL service that sets `DATABASE_URL`. There is no aggregate job: the trunk ruleset requires each leg by name, "ci (node lts)" and "ci (node latest)"; renaming a leg means updating the ruleset in the same change. The published `effect` floors are not tested in CI before 1.0 (below). A new push to a pull request cancels its superseded run. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)). Every workflow defaults to `permissions: {}` with per-job grants, pins each action to a commit SHA, checks out without persisted credentials (except the Release job, whose Changesets step pushes), interpolates no event text into `run:`, and needs no secret outside the Release job, which runs only on pushes to `trunk`, so Dependabot PRs run CI safely. `uvx zizmor --offline .github` audits the workflows (config in `.github/zizmor.yml`).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [Branches and pull requests](#branches-and-pull-requests) requires one.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the package `README.md` for any exported change; the package `AGENTS.md` for a new term or invariant.

## Running individual checks

```sh
vp fmt                                     # Oxfmt (writes)
vp lint                                    # Oxlint, with the Effect presets
vp run build                               # every package's dist/
vp run pack:check                          # pack + lint the publish tarballs
vp run check                               # the type gate (packages and tests)
vp run check:examples                      # each example app's own typecheck
vp test run packages/jsonapi               # one package's tests (no build needed)
vp test run --project svelte               # one Vitest project
vp run test:coverage                       # the suite + coverage map for fallow
vp run ci                                  # every gate, in order, as CI runs them
vp run bench                               # the benchmarks
vp exec fallow audit --base origin/trunk   # the fallow gate
vp exec fallow dead-code                   # unused files, exports, dependencies
```

## Tests

Tests use [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest) (plain Vitest APIs come from `vite-plus/test`):

- `it.effect("...", () => Effect.gen(function* () { ... }))` — runs under TestServices (deterministic `TestClock`; advance time with `TestClock.adjust`). Use for pure logic and anything whose timing you control.
- `it.live("...", () => ...)` — real clock and services. Use for tests that need real concurrency timing or do real I/O (WebSockets, IndexedDB).
- `it.layer(layer)("suite", (it) => { ... })` — build a layer once and share it across the tests inside; services are available directly in each test effect's context.
- Assertions go inside the effect; never wrap tests in `Effect.runPromise`.

**Chromium.** The commerce façade's browser test (`examples/commerce/tests/facade-browser.test.ts`) fails, never skips, without Chromium. Install the revision `playwright-core` expects with `pnpm exec playwright-core install chromium`.

**PostgreSQL test.** `packages/effect/src/__tests__/sql/sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test (#360) against a real server. Set `DATABASE_URL` to a PostgreSQL URL for a throwaway database: the test drops and recreates `todos`, `effects` and `sync_mutations`, and drops them again when it finishes. Without the variable the suite is skipped locally with a warning; in CI (where `CI` is set) it fails instead. For example: `DATABASE_URL=postgres://postgres@127.0.0.1:5432/scratch vp test run packages/effect/src/__tests__/sql`.

### Refreshing the postgres image digest

The `postgres` service container in `.github/workflows/ci.yml` (the `ci` job) pins the image by digest (`postgres:16@sha256:…`). Dependabot does not update images under a workflow's `services:` key, so refresh the digest by hand when moving to a newer Postgres 16 build. Read the multi-arch index digest from Docker Hub's registry API:

```sh
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/library/postgres/manifests/16 | grep -i '^docker-content-digest'
```

Replace the digest in both `services.postgres.image` entries, keeping the `postgres:16` tag for readability, and let CI run the PostgreSQL test against the new image.

## Effect Code

Use Effect for side effects, dependency injection, and typed failures.

Conventions:

- Services: interface + `Context.Service<Interface>("@thomasfosterau/legation-<pkg>/<Name>")` constant of the same name
- Errors: `Data.TaggedError` classes
- Every service has a `layer`; in-memory implementations exist for everything so tests never need external infrastructure
- Use the vocabulary from [CONTEXT.md](CONTEXT.md)

## Effect version upgrades

Two different numbers describe the Effect version, and they move separately (ADR-0003, update of 2026-09-27):

- **The exact dev pin** is the `effect` entry in the `pnpm-workspace.yaml` catalog, together with every companion `@effect/*` runtime package at the same version (including two transitive dependencies that `overrides` holds at the catalog version: `@effect/platform-node-shared`, of `@effect/platform-node`, and `@effect/sql-d1`, of `@alchemy.run/cloudflare`), and is locked in `pnpm-lock.yaml`. Every package references it as `effect: "catalog:"` in `devDependencies`, and `overrides` forces `effect` itself to the catalog singleton.
- **The published floor** is the `effect` entry under `catalogs.peers` (`^4.0.0`, and the same range on the `@effect/platform-*` peers), which each package's `peerDependencies` names as `catalog:peers`; a package whose own dependency requires a newer `effect` names a catalog of its own instead (`catalog:alchemy-peers`, `^4.1.0` for legation-alchemy-cloudflare, because `alchemy` 2.0.0-beta.85 peers `effect ^4.1.0`; `catalog:auth-peers`, `^4.1.0` for legation-auth, because `@thomasfosterau/effect-auth` 0.2.x peers `effect ^4.1.0`; `catalog:jsonapi-peers`, `^4.1.0` for legation-jsonapi, because `@thomasfosterau/effect-jsonapi` 0.22.x peers `effect ^4.1.0`); `pnpm pack` writes the range into the published manifest. It is never an exact version: an exact published peer makes the package impossible to install beside a library that needs a different release (`vp run pack:check` fails on one).

To bump the **dev pin**:

1. In one PR, set the new version on every `effect` / `@effect/*` runtime entry in the catalog (not `@effect/tsgo` or `@effect/language-service`, which are on their own lines), then `pnpm install`, and check that `pnpm-lock.yaml` lists a single version of `effect` and of each `@effect/*` runtime package. Dependabot's `effect` group proposes exactly this set.
2. Run all quality gates; fix any API breakage in the same PR.
3. No changeset: the dev pin is not part of any published manifest (the peer range is), so moving it releases nothing. Add a changeset only when the bump changes our own API or behaviour, and then for the packages it changes.

The owner's policy fixes the **floor** at `^4.0.0`: raise it only when a dependency requires it (a runtime dependency or required peer whose own `effect` range excludes 4.0.x), and only for the packages that take that dependency, in a named catalog whose comment names the dependency. Our own code needing a newer API is not a reason: write it to run on 4.0.0 (feature-detect, or use the 4.0 API). To prove a floor, re-run the gates with the catalog temporarily at it; update each affected package README's "Effect version" section. Raising a floor is a `minor` changeset for every package it moves.

**Checking a floor.** CI does not test the published floors before 1.0 (the owner's decision); `vp run ci:floor` (`scripts/effect-floor.mjs`) checks one by hand, against the floor rather than the pin. `effect` is a singleton, so each floor is its own install: the core's (`core`: `catalogs.peers.effect`, the `node` and `svelte` projects), legation-alchemy-cloudflare's (`alchemy-cloudflare`: `catalogs.alchemy-peers.effect`, 4.1.0 because `alchemy` requires it, its own `alchemy-cloudflare` project), legation-auth's (`auth`: `catalogs.auth-peers.effect`, 4.1.0 because `@thomasfosterau/effect-auth` requires it, its own `auth` project) and legation-jsonapi's (`jsonapi`: `catalogs.jsonapi-peers.effect`, 4.1.0 because `@thomasfosterau/effect-jsonapi` 0.22 requires it, its own `jsonapi` project plus `commerce-browser`, the commerce example's tests of its façade, after the build and `ci:chromium`). Each check points the catalog entries versioned with effect (`effect` and the `@effect/*` runtime packages, the `overrides`-held transitive ones included) at its floor (`node scripts/effect-floor.mjs point <catalog>`), installs (`pnpm install --no-frozen-lockfile`), checks the lockfile holds only that floor (`verify`), and runs `vp run ci:floor` with `FLOOR` set, which runs that floor's projects. They never move `typescript`, `@typescript/native`, `@effect/tsgo` or `@effect/language-service`, and run only the tests (the other gates run at the pin in `vp run ci`). To run one: `node scripts/effect-floor.mjs point jsonapi-peers && pnpm install --no-frozen-lockfile && FLOOR=jsonapi vp run ci:floor`, then `git checkout pnpm-workspace.yaml pnpm-lock.yaml && vp install --frozen-lockfile`. Run the floors a change could break before raising or relying on one; nothing in CI catches a broken floor before 1.0.

## Releases

The release pipeline, its checks and the owner's one-time setup are in [PUBLISHING.md](PUBLISHING.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
