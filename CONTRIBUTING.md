# Contributing to effect-sync

Thank you for contributing. This repository is a bun-workspaces monorepo using TypeScript, Effect v4 beta, Vitest, Oxlint, Prettier, Fallow, and Changesets.

## Setup

```bash
git clone https://github.com/thomasfosterau/effect-synchronizer.git
cd effect-synchronizer
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
bunx vitest run packages/core
```

## Project Structure

```text
packages/
  core/      @thomasfosterau/effect-sync-core      Shared sync/cache primitives
  client/    @thomasfosterau/effect-sync-client    Client query/mutation/subscription manager
  cache/     @thomasfosterau/effect-sync-cache     Write-through cache for SW/edge
  server/    @thomasfosterau/effect-sync-server    Server sync hub with fan-out
  jsonapi/   @thomasfosterau/effect-sync-jsonapi   JSON:API adapter
docs/
  adr/       Architecture decision records
  audit/     Production-readiness audits
  agents/    Agent workflow docs
CONTEXT.md   Domain glossary — use its vocabulary in code and issues
```

Each package follows the same layout: `src/*.ts` modules with JSDoc, `src/__tests__/*.test.ts` vitest tests, `src/index.ts` exporting modules as namespaces (`export * as SyncKey from "./SyncKey.js"`).

## Cross-package development

- Packages import each other by published name (`@thomasfosterau/effect-sync-core`); bun workspaces link them.
- `tsc --build` (project references) handles build order; vitest resolves workspace packages to source via aliases in `vitest.config.ts`, so tests never require a prior build.
- `effect` is a **peer dependency** of every package, pinned to the exact beta version. Never add it as a regular dependency.

## Development Workflow

1. Create a feature branch.
2. Make focused changes.
3. Run the quality gates locally (build, typecheck, test, lint, format).
4. Add or update tests for behavior changes.
5. Add a changeset for user-facing or package-impacting changes: `bun run changeset`.
6. Open a pull request.

## Effect Code

Use Effect for side effects, dependency injection, and typed failures. Repository instructions require consulting `effect-solutions` before writing Effect code; if the local tool is unavailable, **verify APIs against the installed type definitions** (`node_modules/effect/dist/*.d.ts`) — this codebase targets Effect v4 beta, whose APIs differ from v3 (and from most online documentation).

Conventions:

- Services: interface + `Context.Service<Interface>("@thomasfosterau/effect-sync-<pkg>/<Name>")` constant of the same name
- Errors: `Data.TaggedError` classes
- Every service has a `layer`; in-memory implementations exist for everything so tests never need external infrastructure
- Use the vocabulary from [CONTEXT.md](CONTEXT.md)

## Releases

Merges to `main` run the release workflow. Changesets opens/updates a version PR or publishes when a version PR is merged. Publishing requires the `NPM_TOKEN` repository secret.

## Reporting Issues

Please include a clear description, reproduction steps, expected behavior, actual behavior, environment details, and a small code sample when possible.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
