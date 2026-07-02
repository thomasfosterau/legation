# Contributing to legation

Thank you for contributing. This repository is a bun-workspaces monorepo using TypeScript, Effect v4 beta, Vitest, Oxlint, Prettier, Fallow, and Changesets.

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
- `effect` is a **peer dependency** of every package, pinned to the exact beta version. Never add it as a regular dependency.

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

The exact beta version lives once in the root **Bun catalog**
(`package.json` → `workspaces.catalog`). Every package references it as
`effect: "catalog:"` in `devDependencies`; `peerDependencies` (the published
contract) carry the same version as a concrete string, because `changeset
publish` does not rewrite the `catalog:` protocol. To bump it:

1. In one PR, set the new version in the catalog (root `package.json`
   `workspaces.catalog`) and update the concrete `peerDependencies` in every
   `packages/*/package.json` to match, then `bun install`.
2. Run all quality gates; fix any API breakage in the same PR.
3. Add a changeset (patch for all packages unless the bump changes our own API).

A scheduled GitHub Actions workflow (`effect-beta-compat.yml`) runs weekly against the
latest `effect@beta` and reports incompatibilities ahead of time. It never blocks CI —
it exists so beta bumps are informed decisions (see ADR-0003).

## Releases

Merges to `main` run the release workflow (`.github/workflows/release.yml`). It
verifies the build, then runs `changesets/action@v1`: if unreleased changesets
exist it opens or updates a **Version Packages** PR (running `changeset
version`); when that PR is merged it publishes (`changeset publish`). Publishing
requires the `NPM_TOKEN` repository secret — a granular or automation token from
npm with publish rights to the `@legation` scope. Provenance is enabled
(`id-token: write` + `NPM_CONFIG_PROVENANCE`), so the workflow must stay on a
public repository.

### First release (manual, once per package)

`changeset publish` can only version-bump packages that already exist on the
registry, and the `@legation` scope must be provisioned before automation can
use it. The initial publish is therefore done by hand:

1. Create the `@legation` organisation/scope on npm and confirm you have
   publish rights.
2. Create the `NPM_TOKEN` repository secret so the workflow can publish
   thereafter.
3. From a clean checkout of `main`:

   ```sh
   npm login
   bun ci
   bun run build
   npm publish --workspaces --access public   # or `bun run release`
   ```

   `--access public` matches `.changeset/config.json` (`access: "public"`); it
   is required because the packages are scoped.

Once every package has a published `0.1.0`, the workflow above takes over:
land changesets on `main`, merge the Version Packages PR, and releases publish
automatically.

## Reporting Issues

Please include a clear description, reproduction steps, expected behavior, actual behavior, environment details, and a small code sample when possible.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
