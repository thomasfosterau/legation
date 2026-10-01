# Contributing to legation

legation is a bun-workspaces monorepo (bun, not the programme's pnpm + Vite+); every command below runs through bun.

## Setup

```bash
git clone https://github.com/thomasfosterau/legation.git
cd legation
bun ci
```

## Commands and repository rules

The command reference, the pre-push gate list, the package boundaries and the
conventions live in [CLAUDE.md](CLAUDE.md) (the agent guidance, which applies to
everyone): see [Commands](CLAUDE.md#commands),
[Verification](CLAUDE.md#verification), [Common pitfalls](CLAUDE.md#common-pitfalls)
and [Conventions](CLAUDE.md#conventions). Two workspace mechanics it doesn't
repeat:

- Packages import each other by published name (`@legation/effect`); bun workspaces link them.
- `tsc --build` (project references) handles build order; Vitest resolves workspace packages to source via aliases in `vitest.config.ts`, so tests never need a prior build.

## Development Workflow

1. Create a feature branch.
2. Make focused changes.
3. Run the gates in [CLAUDE.md → Verification](CLAUDE.md#verification), in that order.
4. Add or update tests for behavior changes.
5. Add a changeset where [CLAUDE.md → Branches and pull requests](CLAUDE.md#branches-and-pull-requests) says one is needed (`bun run changeset`).
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

Use Effect for side effects, dependency injection, and typed failures.

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
  `peerDependencies` (`"effect": ">=4.0.0-rc.118"`, and the same range on the
  `@effect/platform-*` peers). It is written as a concrete string because
  `changeset publish` does not rewrite the `catalog:` protocol. It is never an
  exact version: an exact published peer makes the package impossible to
  install beside a library that needs a different release.

To bump the **dev pin**:

1. In one PR, set the new version on every catalog entry and on the
   `overrides` entry, then `bun install`, and check that `bun.lock` lists a
   single version of `effect` and of each `@effect/*` package.
2. Run all quality gates; fix any API breakage in the same PR.
3. No changeset: the dev pin is not part of any published manifest (the peer
   range is), so moving it releases nothing. Add a changeset only when the bump
   changes our own API or behaviour, and then for the packages it changes.

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
runs `npm publish` per package) and tags the release. That publish step does
not yet rewrite `workspace:^` dependencies; see
[#267](https://github.com/thomasfosterau/legation/issues/267) before the first
release.

Publishing uses npm [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers):
there is no `NPM_TOKEN` secret. The workflow proves its identity to npm with a
short-lived, workflow-bound token (`id-token: write`), and provenance is
left to npm, which attaches it only when allowed (a public source repository);
it is never forced, because an explicit request fails from a private
repository. The publish job
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
2. Build from a clean checkout of `trunk` (`bun ci`, then `bun run build`)
   and publish each package. Don't use `npm publish --workspaces` or
   `bun run release` (`changeset publish`) for this yet: neither appears to
   rewrite the `workspace:^` dependencies on `@legation/effect` and
   `@legation/sql`, so the dependent packages would probably publish
   uninstallable manifests. The fix, and the command to use instead,
   is tracked in [#267](https://github.com/thomasfosterau/legation/issues/267).
   Whatever publishes must pass `--access public`, matching
   `.changeset/config.json` (`access: "public"`), because the packages are
   scoped.

3. Attach the trusted publisher to each published package (maintainer setup
   step 2 above).

Once every package has a published `0.1.0` and a trusted publisher, the
workflow above takes over: land changesets on `trunk`, merge the Version
Packages PR, approve the `release` environment, and releases publish
automatically.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
