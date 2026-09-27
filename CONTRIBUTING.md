# Contributing to legation

Thank you for contributing. This repository is a bun-workspaces monorepo using TypeScript, Effect v4 (release-candidate line), Vitest, Oxlint, Prettier, Fallow, and Changesets.

## Setup

```bash
git clone https://github.com/thomasfosterau/legation.git
cd legation
bun ci
```

## Common Commands

```bash
bun run build           # Build all packages (tsc project references)
bun run typecheck       # Typecheck all packages including tests
bun run test:run        # Run all tests once
bun run test:coverage   # Run tests with coverage
bun run lint            # Oxlint
bun run lint:fix        # Oxlint safe fixes
bun run format:check    # Check Prettier formatting
bun run format          # Apply Prettier formatting
bun run analyze:audit   # Fallow CI audit
```

Run a single package's tests:

```bash
bunx vitest run packages/effect
```

## Project Structure

```text
packages/
  core/      @legation/effect      The sync engine (primitives, client, SW/edge cache, server hub)
  browser/   @legation/browser   Browser runtime: WebSocket client transport, IndexedDB store
  node/      @legation/node      Node runtime: ws-based WebSocket server transport
  jsonapi/   @legation/jsonapi   JSON:API protocol adapter
docs/
  adr/       Architecture decision records
  audit/     Production-readiness audits
  agents/    Agent workflow docs
CONTEXT.md   Domain glossary — use its vocabulary in code and issues
```

Each package follows the same layout: `src/*.ts` modules with JSDoc, `src/__tests__/*.test.ts` vitest tests, `src/index.ts` exporting modules as namespaces (`export * as SyncKey from "./SyncKey.js"`).

## Cross-package development

- Package boundaries are dependency-based (ADR-0006): code that needs only `effect` goes in `core`; protocol/framework-specific code gets its own package.
- Packages import each other by published name (`@legation/effect`); bun workspaces link them.
- `tsc --build` (project references) handles build order; vitest resolves workspace packages to source via aliases in `vitest.config.ts`, so tests never require a prior build.
- `effect` is a **peer dependency** of every package, declared as an open floor (`>=4.0.0-rc.113`); the exact version lives only in the root catalog and `bun.lock`. Never add it as a regular dependency.

## Development Workflow

1. Create a feature branch.
2. Make focused changes.
3. Run the quality gates locally (build, typecheck, test, lint, format).
4. Add or update tests for behavior changes.
5. Add a changeset for user-facing or package-impacting changes: `bun run changeset`.
6. Open a pull request.

## Tests

Tests use [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest):

- `it.effect("...", () => Effect.gen(function* () { ... }))` — runs under TestServices
  (deterministic `TestClock`; advance time with `TestClock.adjust`). Use for pure logic and
  anything whose timing you control.
- `it.live("...", () => ...)` — real clock and services. Use for tests that need real
  concurrency timing or do real I/O (WebSockets, IndexedDB).
- `it.layer(layer)("suite", (it) => { ... })` — build a layer once and share it across the
  tests inside; services are available directly in each test effect's context.
- Assertions go inside the effect; never wrap tests in `Effect.runPromise`.

## Effect Code

Use Effect for side effects, dependency injection, and typed failures. Repository instructions require consulting `effect-solutions` before writing Effect code; if the local tool is unavailable, **verify APIs against the installed type definitions** (`node_modules/effect/dist/*.d.ts`) — this codebase targets Effect v4 beta, whose APIs differ from v3 (and from most online documentation).

Conventions:

- Services: interface + `Context.Service<Interface>("@legation/<pkg>/<Name>")` constant of the same name
- Errors: `Data.TaggedError` classes
- Every service has a `layer`; in-memory implementations exist for everything so tests never need external infrastructure
- Use the vocabulary from [CONTEXT.md](CONTEXT.md)

## Effect version upgrades

Two different numbers describe the Effect version, and they move separately
(ADR-0003, update of 2026-09-27):

- **The exact dev pin** lives once in the root **Bun catalog**
  (`package.json` → `workspaces.catalog`), together with every companion
  `@effect/*` package at the same version, and is locked in `bun.lock`. Every
  package references it as `effect: "catalog:"` in `devDependencies`. The root
  `overrides` entry holds `@effect/platform-node-shared` (a transitive
  dependency of `@effect/platform-node`, which it ranges with a caret) at the
  same version, so the lockfile carries exactly one Effect line.
- **The published floor** is the open range in each package's
  `peerDependencies` (`"effect": ">=4.0.0-rc.113"`, and the same range on the
  `@effect/platform-*` peers). It is written as a concrete string because
  `changeset publish` does not rewrite the `catalog:` protocol. It is never an
  exact version: an exact published peer makes the package impossible to
  install beside a library that needs a different release.

To bump the **dev pin**:

1. In one PR, set the new version on every catalog entry and on the
   `overrides` entry, then `bun install`, and check that `bun.lock` lists a
   single version of `effect` and of each `@effect/*` package.
2. Run all quality gates; fix any API breakage in the same PR.
3. Add a changeset (patch for all packages unless the bump changes our own API).

Raise the **floor** only when the code needs an API newer than it: re-run the
gates with the catalog temporarily at the new floor, update the peer ranges and
each package README's "Effect version" section, and agree the number with the
sibling libraries first (effect-jsonapi, then effect-auth, then legation
publish in that order). Moving the floor is a `minor` changeset for every
package.

A scheduled GitHub Actions workflow (`effect-beta-compat.yml`) runs weekly
against the latest `effect@rc` (the dist-tag the release-candidate line
publishes under) and reports incompatibilities ahead of time. It never blocks
CI — it exists so bumps are informed decisions (see ADR-0003).

## Releases

Merges to `trunk` run the release workflow (`.github/workflows/release.yml`).
It verifies the build, then runs `changesets/action`: if unreleased changesets
exist it opens or updates a **Version Packages** PR (running `changeset
version`); when that PR is merged it publishes (`changeset publish`, which
runs `npm publish` per package) and tags the release.

Publishing uses npm [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers):
there is no `NPM_TOKEN` secret. The workflow proves its identity to npm with a
short-lived, workflow-bound token (`id-token: write`), and provenance is
attached automatically, so the repository must stay public. The publish job
runs in a protected `release` GitHub Environment so it pauses for manual
approval, and never runs on forks.

### Maintainer setup (one-time)

1. **Allow Actions to open the Version Packages PR.** **Settings → Actions →
   General → Workflow permissions** → enable **"Allow GitHub Actions to create
   and approve pull requests"**. Without it the built-in `GITHUB_TOKEN` cannot
   open pull requests even though the job grants `pull-requests: write`.
2. **Configure the trusted publisher on every package.** A trusted publisher
   can only be attached to a package that already exists on npm (see the first
   release below). For each `@legation/*` package on npmjs.com, open
   **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/legation`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** **Settings → Environments →
   `release`** → enable **Required reviewers** (yourself) and restrict
   deployment to the `trunk` branch.
4. **Protect `trunk`.** Require pull requests and passing CI before merge and
   disallow direct pushes, so a release can only be triggered by merging the
   reviewed Version Packages PR.

### First release (manual, once per package)

The `@legation` scope must be provisioned, and each package must exist on the
registry before a trusted publisher can be attached to it. The initial publish
is therefore done by hand, with your own npm login:

1. Create the `@legation` organisation/scope on npm and confirm you have
   publish rights.
2. From a clean checkout of `trunk`:

   ```sh
   npm login
   bun ci
   bun run build
   npm publish --workspaces --access public   # or `bun run release`
   ```

   `--access public` matches `.changeset/config.json` (`access: "public"`); it
   is required because the packages are scoped.

3. Attach the trusted publisher to each published package (maintainer setup
   step 2 above).

Once every package has a published `0.1.0` and a trusted publisher, the
workflow above takes over: land changesets on `trunk`, merge the Version
Packages PR, approve the `release` environment, and releases publish
automatically.

## Reporting Issues

Please include a clear description, reproduction steps, expected behavior, actual behavior, environment details, and a small code sample when possible.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
