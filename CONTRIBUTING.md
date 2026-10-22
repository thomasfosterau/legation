# Contributing to legation

legation is a pnpm 11 + [Vite+](https://viteplus.dev) (`vp`) workspace on Node 22 or later. The command reference, the gate list, the package boundaries and the conventions live in [AGENTS.md](AGENTS.md) (the agent guidance, which applies to everyone): see [Commands](AGENTS.md#commands), [Verification](AGENTS.md#verification), [Common pitfalls](AGENTS.md#common-pitfalls) and [Conventions](AGENTS.md#conventions).

## Setup

```bash
git clone https://github.com/thomasfosterau/legation.git
cd legation
corepack enable   # or any pnpm 10+, which switches itself to the pinned pnpm 11
pnpm install
```

`pnpm install` also installs the Vite+ git hooks and runs `prepare`, which patches the native TypeScript compiler and Oxlint with `@effect/tsgo` so Effect diagnostics fail the type gate.

Two workspace mechanics AGENTS.md doesn't repeat:

- Packages import each other by published name (`@thomasfosterau/legation-effect`); pnpm links the workspace packages, and `pnpm pack` rewrites the `workspace:` and `catalog:` specifiers when a package is published.
- `vp run build` builds the packages in dependency order (`vp pack`, one task per package); the tests resolve the package names to `src/` through aliases in the root `vite.config.ts`, so tests never need a prior build. The example apps and the commerce browser test consume `dist/`, so `vp run test` builds first.

## Branches

Branch off `trunk`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on the staged files). There is no pre-push hook: run the gates yourself.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs "Quality Gates", whose steps are the gate list in [AGENTS.md](AGENTS.md#verification), and "Tests (effect floor)" (below). [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the package `README.md` for any exported change; the package `CLAUDE.md` for a new term or invariant.

## Running individual checks

```sh
vp fmt                                     # Oxfmt (writes)
vp lint                                    # Oxlint, with the Effect presets
vp run build                               # every package's dist/
vp run pack:check                          # pack + lint the publish tarballs
vp run check                               # the type gate (packages and tests)
vp run check:examples                      # each example app's own typecheck
vp test run packages/sql                   # one package's tests (no build needed)
vp test run --project svelte               # one Vitest project
vp run test:coverage                       # the suite + coverage map for fallow
vp run bench                               # the benchmarks
fallow audit --base origin/trunk           # the fallow gate
fallow dead-code                           # unused files, exports, dependencies
```

## Tests

Tests use [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest) (plain Vitest APIs come from `vite-plus/test`):

- `it.effect("...", () => Effect.gen(function* () { ... }))` — runs under TestServices (deterministic `TestClock`; advance time with `TestClock.adjust`). Use for pure logic and anything whose timing you control.
- `it.live("...", () => ...)` — real clock and services. Use for tests that need real concurrency timing or do real I/O (WebSockets, IndexedDB).
- `it.layer(layer)("suite", (it) => { ... })` — build a layer once and share it across the tests inside; services are available directly in each test effect's context.
- Assertions go inside the effect; never wrap tests in `Effect.runPromise`.

**Chromium.** The commerce façade's browser test (`examples/commerce/tests/facade-browser.test.ts`) fails, never skips, without Chromium. Install the revision `playwright-core` expects with `pnpm exec playwright-core install chromium`.

**PostgreSQL test.** `packages/sql/src/__tests__/sql-backend-postgres.test.ts` runs the READ COMMITTED overlap test (#360) against a real server. Set `DATABASE_URL` to a PostgreSQL URL for a throwaway database: the test drops and recreates `todos`, `effects` and `sync_mutations`, and drops them again when it finishes. Without the variable the suite is skipped locally with a warning; in CI (where `CI` is set) it fails instead. For example: `DATABASE_URL=postgres://postgres@127.0.0.1:5432/scratch vp test run packages/sql`.

### Refreshing the postgres image digest

Both `postgres` service containers in `.github/workflows/ci.yml` pin the image by digest (`postgres:16@sha256:…`). Dependabot does not update images under a workflow's `services:` key, so refresh the digest by hand when moving to a newer Postgres 16 build. Read the multi-arch index digest from Docker Hub's registry API:

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

- **The exact dev pin** is the `effect` entry in the `pnpm-workspace.yaml` catalog, together with every companion `@effect/*` runtime package at the same version (including `@effect/platform-node-shared`, a transitive dependency of `@effect/platform-node` that `overrides` holds at the catalog version), and is locked in `pnpm-lock.yaml`. Every package references it as `effect: "catalog:"` in `devDependencies`, and `overrides` forces `effect` itself to the catalog singleton.
- **The published floor** is the `effect` entry under `catalogs.peers` (`">=4.0.0-rc.118"`, and the same range on the `@effect/platform-*` peers), which each package's `peerDependencies` names as `catalog:peers`; `pnpm pack` writes the range into the published manifest. It is never an exact version: an exact published peer makes the package impossible to install beside a library that needs a different release (`vp run pack:check` fails on one).

To bump the **dev pin**:

1. In one PR, set the new version on every `effect` / `@effect/*` runtime entry in the catalog (not `@effect/tsgo` or `@effect/language-service`, which are on their own lines), then `pnpm install`, and check that `pnpm-lock.yaml` lists a single version of `effect` and of each `@effect/*` runtime package. Dependabot's `effect` group proposes exactly this set.
2. Run all quality gates; fix any API breakage in the same PR.
3. No changeset: the dev pin is not part of any published manifest (the peer range is), so moving it releases nothing. Add a changeset only when the bump changes our own API or behaviour, and then for the packages it changes.

Raise the **floor** only when the code needs an API newer than it: re-run the gates with the catalog temporarily at the new floor, update `catalogs.peers` and each package README's "Effect version" section, and agree the number with the sibling libraries first (effect-jsonapi, then effect-auth, then legation publish in that order). Moving the floor is a `minor` changeset for every package.

CI's **Tests (effect floor)** job (`ci.yml`) runs the test suite on every PR against the published floor as well as the pin: it reads the floor from `catalogs.peers.effect`, points the catalog entries versioned with effect (`effect` and the `@effect/*` runtime packages, `@effect/platform-node-shared` included) at it in its own checkout, then installs (`pnpm install --no-frozen-lockfile`) and runs `vp run test`. It never moves `typescript`, `@typescript/native`, `@effect/tsgo` or `@effect/language-service`, and runs only the tests (the other gates run at the pin in Quality Gates). It blocks the PR like any other job, so a change that breaks the floor has to raise it deliberately (above) rather than land silently.

## Releases

The release pipeline, its checks and the owner's one-time setup are in [PUBLISHING.md](PUBLISHING.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
