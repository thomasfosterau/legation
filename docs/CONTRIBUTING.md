# Contributing

## Workflow

The main branch is `trunk`. Branch off `trunk`, open a pull request into `trunk`, and squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

- **Open a draft PR early**, so others can see the work is taken.
- **One PR per change**, even a large one spanning many commits.
- **Rebase, don't merge**: rebase onto `origin/trunk`; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- **File issues** for bugs or improvements outside your change instead of fixing them in passing or leaving a TODO. Keep issue bodies evergreen: edit the body as the problem and the chosen solution become clear.
- **Dependabot** keeps dependencies current (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm; use it rather than calling them directly (`vp exec <bin>`, not `npx`). `vp install` installs dependencies, the git hooks and the Effect-patched `tsc` / `oxlint` (`prepare`). The pre-commit hook runs `vp staged` (format with fixes, then lint) and `vp run fallow:audit`.

| Command                                | What it does                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp check`                             | Format and type-aware lint                                                                                                                 |
| `vp run build`                         | Every package's `dist/` (`vp pack`)                                                                                                        |
| `vp run pack:check`                    | Packs each publishable package as `vp pm publish` does and checks the tarball (specifiers, ranges, publint, attw); the release runs it too |
| `vp run check`                         | The type gate: packages and tests in one Effect-patched `tsc` program                                                                      |
| `vp run check:examples`                | Each example app's own `tsc` / `svelte-check`, against `dist/`                                                                             |
| `vp run test` / `vp run test:coverage` | Every Vitest project (builds first); with the coverage map                                                                                 |
| `vp test run packages/<name>`          | One package's tests, no build needed                                                                                                       |
| `vp run ci`                            | Everything CI runs, in order                                                                                                               |
| `vp run bench`                         | Benchmarks (not a gate)                                                                                                                    |
| `vp run github:plan` / `github:deploy` | The repository's GitHub settings (`stacks/github.ts`); owner-run, with an admin `GITHUB_TOKEN` and Alchemy's state-store credentials       |

Two suites need more than Node: the commerce façade's browser test needs Chromium (`vp run ci:chromium`; it fails rather than skips without it), and the PostgreSQL overlap test needs `DATABASE_URL` pointing at a throwaway database (it skips locally without one, and fails in CI).

[Fallow](https://docs.fallow.tools) checks module boundaries (`.fallowrc.json`), dead code, complexity and duplication. `vp run fallow:audit` (run by the pre-commit hook, after `test:coverage`, whose map it reads) audits your change against `origin/trunk`. Its findings are guidance, not dogma; it is also the last step of `vp run ci`.

## Coding guidelines

- **Effect.** Use Effect v4 idioms throughout and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, `Stream`, …) to hand-rolled equivalents; convert existing code where practical. Exceptions: Svelte component code, non-Effect third-party APIs (adapt them at the edge), and hot paths where a measurement shows plain code is needed. Read the installed package rather than guessing an API (`node_modules/effect/` ships `AGENTS.md`, `ai-docs/`, typings and source); HTTP is `effect/http/*`, RPC `effect/rpc`. Services are `Context.Service`s with a `layer` and an in-memory implementation; errors are `Data.TaggedError`s. Use the vocabulary in [CONTEXT.md](../CONTEXT.md), and say so when a change contradicts an [ADR](adr/).
- **Imports.** Effect modules as namespaces from their submodule (`import * as Effect from "effect/Effect"`), with the aliases `Arr`, `P`, `R`, `Str`, `Eq`, `Bool` for `Array`, `Predicate`, `Record`, `String`, `Equal`, `Boolean`. Relative imports carry `.js`.
- **Exports** follow Effect's layout: each package's `src/index.ts` re-exports its modules as PascalCase namespaces (`export * as Node from "./Node.js"`), and a module that gets its own entry takes a PascalCase subpath (`./Node`). App-facing names go on `@thomasfosterau/legation`, engine seams on `/internal`.
- **Lint.** Fix findings in code. A rule is relaxed only in `vite.config.ts`, with its reason; the `warn` allowances there are debt, and a new site is a defect.
- **Comments.** A file-level comment only for real context, under 50 words. Doc comments where they help someone reading IntelliSense, adding to the signature; every exported item starts with a one-sentence summary. Inline comments only for what the code can't say (workarounds, performance, non-obvious decisions). Don't reference issues, PRs or CI runs; stable links to external docs are fine.
- **Tests** check logic: edge cases, regressions, behaviour. Don't test what the type system or a lint enforces. Use `@effect/vitest` (`it.effect`, `it.live` for real time or I/O, `it.layer`) or `vite-plus/test`, never `vitest`; assertions go inside the effect.

## Before pushing

Run `vp run ci`, which runs, in order and stopping at the first failure: `vp check`, `build`, `pack:check`, `check`, `check:examples`, `ci:chromium`, `test:coverage`, `pnpm audit --audit-level high` and `fallow audit`. Say in the PR body which gates couldn't run.

CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest` with a PostgreSQL service, holding no secrets. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to a published package's behaviour, or to doc comments that reach its `.d.ts`, needs a changeset (`pnpm changeset`) naming each package it touches. Docs-, CI- and tooling-only changes need none, and neither does a private package. Never version or publish by hand: the Release workflow opens the "chore: version packages" PR ([PUBLISHING.md](PUBLISHING.md)).

## Dependencies

Dependabot ([dependabot.yml](../.github/dependabot.yml)) opens `@thomasfosterau/*` updates daily and every other update weekly, on Wednesday morning Melbourne time: the named runtime sets (`effect` and the like) each in one PR, and every other development dependency in the single `toolchain` group. Security updates skip the schedule and open as soon as an advisory lands, one PR each. Vite+ selects Node.js from `.node-version` and pnpm from `packageManager`; pnpm's own switching is off (`runtimeOnFail` / `pmOnFail`), so one version of each is installed and used.

Every external version is in the `pnpm-workspace.yaml` catalog; package.json files use `catalog:`, `catalog:<name>` or `workspace:`. After editing the catalog, run `vp install` and commit `pnpm-lock.yaml`.

Dependabot groups the sets that must move together. It can't make the moves below: make them in a PR from a new branch started from its PR's head (never push to a `dependabot/*` branch, which stops it rebasing), and it closes its own PR once yours merges:

- **Toolchain** (`vite-plus`): run `vp dlx --package=vite-plus@<v> vp migrate --no-interactive` to re-pin `vite` and `vitest`, then drop the `minimumReleaseAgeExclude` entries it adds, and move the devcontainer image tag. `typescript` / `@typescript/native` move only with an `@effect/tsgo` that supports them (see its catalog comment).
- **Effect**: move the `@effect/*` entries referenced only from `overrides` to the new version.
- **Alchemy**: move `catalogs.alchemy-peers` with it, with a `minor` changeset.

**Effect floors.** The catalog's `effect` is the dev pin; the published floors are `catalogs.peers` (`^4.0.0`) and the named `catalogs.*-peers`, raised only when a package's own dependency requires it (named in the catalog comment), with a `minor` changeset. CI doesn't test the floors before 1.0. To check one by hand: `node scripts/effect-floor.mjs point <catalog> && pnpm install --no-frozen-lockfile && FLOOR=<core|alchemy-cloudflare|auth|jsonapi> vp run ci:floor`, then restore `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

## Adding a package

A new package adds a row to the README's package table, an `AGENTS.md` (boundary and invariants) with a one-line `CLAUDE.md` (`@AGENTS.md`), a `vite.config.ts` (`packageConfig` from `vite.package.ts`), a `.fallowrc.json` entry, zone and rule, an alias in the root `vite.config.ts` and a `paths` entry in `tsconfig.check.json`, and its name in the root `vite.config.ts` `packages` list.
