# Contributing to @thomasfosterau/effect-chancery

Thank you for contributing. This repository uses Bun, TypeScript, Effect v4 beta, Vitest, Oxlint, Prettier, Fallow, and Changesets.

## Setup

```bash
git clone https://github.com/thomasfosterau/effect-synchronizer.git
cd effect-synchronizer
bun ci
```

## Common Commands

```bash
bun run typecheck       # TypeScript checks
bun run build           # Build ESM output and declarations
bun run test:run        # Run tests once
bun run test:coverage   # Run tests with coverage
bun run lint            # Oxlint
bun run lint:fix        # Oxlint safe fixes
bun run format:check    # Check Prettier formatting
bun run format          # Apply Prettier formatting
bun run analyze:audit   # Fallow CI audit
```

## Project Structure

```text
src/
  __tests__/       Vitest tests
  errors.ts        Typed errors
  index.ts         Public API exports
  storage.ts       In-memory storage implementation
  synchronizer.ts  Core JSON:API synchronization logic
  types.ts         JSON:API type definitions
examples/          Usage examples
.github/workflows/ CI and release automation
.changeset/        Changesets release configuration
```

## Development Workflow

1. Create a feature branch.
2. Make focused changes.
3. Run the quality gates locally.
4. Add or update tests when behavior changes.
5. Add a changeset for user-facing or package-impacting changes.
6. Open a pull request.

```bash
bun run changeset
```

Changesets updates the package version and changelog through an automated version PR. Do not manually edit the package version for normal releases.

## Effect Code

Use Effect for side effects, dependency injection, and typed failures. Repository instructions require consulting `effect-solutions` before writing Effect code; if the local tool is unavailable, use the official Effect docs and mention the missing local guide in the PR notes.

The library currently uses Effect v4 beta HTTP modules from `effect/unstable/http/*`.

## Fallow

Fallow is used for codebase analysis and regression gating. The local `.fallow/` cache is ignored. Committed baselines should live outside `.fallow/`, under `fallow-baselines/`, so CI can be configured to fail only new issues.

## Release Process

Merges to `main` run the release workflow. Changesets will either open/update a version PR or publish when a version PR is merged. Publishing requires the `NPM_TOKEN` repository secret.

## Reporting Issues

Please include a clear description, reproduction steps, expected behavior, actual behavior, environment details, and a small code sample when possible.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
