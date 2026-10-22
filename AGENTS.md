# AGENTS.md

`CLAUDE.md` is a symlink to this file. legation publishes the `@thomasfosterau/legation-*` packages, an Effect v4 (release-candidate line) sync engine and its runtime, protocol and framework adapters. It is a **pnpm 11 + Vite+ (`vp`)** workspace: versions live in the `pnpm-workspace.yaml` catalogs, and every gate is a `vp` command or a `vp run` task defined in `vite.config.ts`. Read `CONTEXT.md` (the glossary) and the `docs/adr/` entries for the area you touch before changing it, and the package's own `CLAUDE.md` (`packages/<name>/CLAUDE.md`) for its boundary and invariants.

| Package                               | Directory             | Entries                      | Purpose / boundary                                                                                                 |
| ------------------------------------- | --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@thomasfosterau/legation-effect`     | `packages/effect`     | `.`, `./internal`            | Engine core. App surface on `.`, engine seams for adapter authors on `./internal` (ADR-0022). Peer: `effect` only. |
| `@thomasfosterau/legation-browser`    | `packages/browser`    | `.`                          | Service-worker / elected host, IndexedDB client store, tab mirrors, Cache API HTTP cache.                          |
| `@thomasfosterau/legation-node`       | `packages/node`       | `.`                          | `HttpSyncServer`: the RPC sync transport on Node HTTP/WebSocket.                                                   |
| `@thomasfosterau/legation-jsonapi`    | `packages/jsonapi`    | `.`                          | JSON:API loaders, derived sync, façade (over `@thomasfosterau/effect-jsonapi`).                                    |
| `@thomasfosterau/legation-sql`        | `packages/sql`        | `.`                          | SQL reference `Backend` over a `SqlExecutor` seam.                                                                 |
| `@thomasfosterau/legation-cloudflare` | `packages/cloudflare` | `.`                          | Durable Object rooms, fan-out shards, D1 executor.                                                                 |
| `@thomasfosterau/legation-svelte`     | `packages/svelte`     | `.`, `./kit`                 | Rune hooks; SvelteKit surface on `./kit`.                                                                          |
| `@thomasfosterau/legation-devtools`   | `packages/devtools`   | `.`, `./svelte` (raw source) | Headless devtools core; Svelte panel on `./svelte` (ships raw `.svelte` source).                                   |

A new package adds a row here and in the root `README.md`, its own `CLAUDE.md` and `vite.config.ts` (`packageConfig` from `vite.package.ts`), a `.fallowrc.json` entry, zone and rule, an alias in the root `vite.config.ts` and a `paths` entry in `tsconfig.check.json`, and its name in the root `vite.config.ts` `packages` list (the `build` aggregate).

## Common pitfalls

- **Code that needs only `effect` goes in `packages/effect`**; runtime-, protocol- or framework-specific code gets its own package (ADR-0006), so the core runs identically in browsers, workers, edge runtimes and Node. `.fallowrc.json`'s boundaries enforce the package dependency graph.
- **App-facing names go on `@thomasfosterau/legation-effect`, engine seams on `@thomasfosterau/legation-effect/internal`** (ADR-0022). Import accordingly in docs, READMEs and examples: `ClientEngine`, `Subset`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo` and the other seams are not on the root entry, so a sample that imports them from it doesn't compile.
- **`effect` is a peer, never a dependency**: two copies break `Context` identity. The dev pin is the catalog's `effect` entry (with every `@effect/*` runtime package at the same version, and `overrides` forcing the singleton); the published floor is `catalogs.peers.effect`, an open range. To move either, follow CONTRIBUTING.md "Effect version upgrades".
- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalogs (`catalogMode: strict`); manifests carry only `catalog:`, `catalog:peers` and `workspace:` specifiers. After editing a catalog, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `vite-plus`, `@effect/tsgo` and `@typescript/native` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **`dist/` is the product.** Each package is a `vp pack` (tsdown) library with one bundle per entry; `exports` points at `dist/`, so the example apps and the commerce browser test consume it the way a consumer does. Tests and `vp run check` resolve the package names to `src/` instead (the root `vite.config.ts` aliases, `tsconfig.check.json` `paths`), so neither needs a build first.
- **Publish only through the Release workflow** (`pnpm run release` → `scripts/publish.mjs`), never `npm publish` in a package directory: npm copies `workspace:` and `catalog:` into the published `package.json` verbatim (#267). `pnpm pack` rewrites them, and `scripts/pack.mjs` checks the tarball (publint strict, attw ESM-only, no exact `effect` peer, `svelte` conditions packed) before `npm publish <tarball>` uploads it under OIDC.

## Conventions

- **Relative imports carry the `.js` extension** (`NodeNext` resolution); each package's `src/index.ts` re-exports its modules as namespaces (`export * as Node from "./Node.js"`).
- **Effect modules are imported as namespaces from their submodule** (`import * as Effect from "effect/Effect"`), never as named imports from the `effect` barrel; Oxlint enforces it.
- **`exactOptionalPropertyTypes` is on**: an optional field a caller may forward `undefined` to is spelled `?: T | undefined`.
- **Tests import from `@effect/vitest` or `vite-plus/test`**, never `vitest`. Service, error and test conventions are in CONTRIBUTING.md ("Effect Code", "Tests").
- **Every export a consumer sees starts its doc comment with a one-sentence summary**, before any tag: hover shows only that text. Write ``@throws `X` when …``, never `@throws {@link X}`, which TypeScript misparses.

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. CI uses `pnpm install --frozen-lockfile`.
- `vp check` — format + lint (Oxfmt + Oxlint, with the Effect presets). `vp check --fix` / `vp fmt` fix what they can.
- `vp run build` — `vp pack` → every package's `dist/`, in dependency order.
- `vp run pack:check` — packs every publishable package with `pnpm pack` and fails on a `workspace:` / `catalog:` specifier left in a packed `package.json`, an internal range that doesn't match the dependency's version, an exact `effect` / `@effect/*` peer, a `svelte` export condition naming a file that isn't packed, or a `publint` (strict) or `attw` (ESM-only: `node10` and `node16-cjs` ignored) finding. Fix a finding; suppress one only in `attwSuppressions` in `scripts/pack.mjs`, with its reason. No registry access.
- `vp run check` — the type gate: packages and tests in one native, Effect-patched `tsc` program (`tsconfig.check.json`). `vp run check:examples` — each example app's own `tsc` / `svelte-check`, against the built `dist/`.
- `vp run test` — every Vitest project (`node`, `commerce-browser`, `svelte`); builds first. `vp test run packages/<name>` runs one package's tests without a build. The commerce browser test needs Chromium (see Agent sessions).
- `vp run test:coverage` — the suite plus `coverage/coverage-final.json`, the map `fallow audit` reads.
- `vp run bench` — the `*.bench.ts` benchmarks (not a gate).
- `fallow audit --base origin/trunk` — the fallow gate (see the blocks at the end). `fallow dead-code`, `fallow dupes` and `fallow health` run the individual analyses.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of a bare `pnpm` script). The sanctioned non-`vp` invocations: `pnpm install`, `pnpm changeset`, `pnpm audit`, `pnpm exec playwright-core install chromium`, and `pnpm run version` / `pnpm run release` on the release path. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run these in CI's order (`.github/workflows/ci.yml`, job "Quality Gates") and quote each command with its final pass/fail:

1. `vp check`
2. `vp run build`
3. `vp run pack:check`
4. `vp run check`
5. `vp run check:examples`
6. `vp run test:coverage` (the suite plus the coverage map the audit reads; needs Chromium, and `DATABASE_URL` for the PostgreSQL overlap test)
7. `pnpm audit --audit-level high` (network)
8. `fallow audit --base origin/trunk` (fetch `origin/trunk` first)

CI also runs the suite at the published `effect` floor ("Tests (effect floor)"). If a gate can't run here, say which and why in the PR body; never imply it ran.

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Add a changeset (`pnpm changeset`) for every user-facing or package-impacting change, naming each package it touches; a doc-comment change that reaches the emitted `.d.ts` takes a `patch`. Docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "chore: version packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
- Standing approvals: once a branch has a pushed commit, open its PR without being asked; watch it to merge or close, investigating CI failures and review comments as they arrive; keep its body current with what the branch does.
- GitHub writes go to `thomasfosterau/legation` only; pass `-R thomasfosterau/legation` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

GitHub Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. The issue is the spec: read it with `gh issue view <n> --comments`; later comments override the body. Record decisions and findings as issue comments. Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop. Scope cut mid-PR becomes a linked issue before merge.

The vendored skills in `.claude/skills/` read their repo config from `docs/agents/`: `issue-tracker.md` (gh conventions), `triage-labels.md` (the label strings) and `domain.md` (which docs to read).

## Effect

Never guess at an Effect API. This repo is on the Effect v4 release-candidate line, whose APIs differ from v3 and from most online docs; the pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog. Read the installed package: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` (the pinned version ships both), the declarations in `node_modules/effect/dist/*.d.ts`, and the source in `node_modules/effect/src/`.

- On this line HTTP lives at `effect/http/*` and RPC at `effect/rpc`; there are no `effect/unstable/*` paths.
- The Effect lint presets (`@effect/tsgo`'s and `@mpsuesser/oxlint-plugin-effect`'s `recommended`) run in `vp check`. A rule at `warn` under "ported-code allowances" in `vite.config.ts` carries the count left when the presets were adopted (the sites are listed in [#497](https://github.com/thomasfosterau/legation/issues/497)): a new site is a defect, not headroom, and a rule whose count reaches zero has its line deleted so it is back at `error`.

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile with pnpm and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`), `fallow` and `tsx` on PATH for non-interactive shells. It hydrates no secrets, and none are needed.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` fails; it reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON, YAML or Markdown file you write or edit.
- `vp run test` and `vp run test:coverage` need Chromium for the commerce façade's browser test, which fails rather than skips without it. Run `pnpm exec playwright-core install chromium` first; if the download is blocked, run `vp test run --project node --project svelte` and say in the PR body that the commerce browser test didn't run. The PostgreSQL overlap test skips locally without `DATABASE_URL` (CI sets it).

## Documentation surfaces

- `README.md`: the landing page. Package `README.md`: the npm-facing API reference. Links into the repo stay relative (npm rewrites them against `repository`), but a consumer must not need them: everything they need is in the README.
- Package `CLAUDE.md`: the package's boundary, invariants and terms (not published).
- `CONTEXT.md`: the domain glossary. `docs/adr/`: architecture decisions (historical records; fix only a wrong status or path, and record a new decision as a new ADR).
- `CONTRIBUTING.md`: human setup, hooks, individual checks, Effect upgrades. `PUBLISHING.md`: the release pipeline and the owner's one-time setup. `SECURITY.md`: the reporting channel and supply-chain posture.
- `docs/agents/`: config the vendored skills read. Decisions and findings go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to...                                     | Run                                          |
| ----------------------------------------------------------------- | -------------------------------------------- |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`   |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR                                               | `fallow audit --base origin/trunk`           |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                       |
| understand a finding                                              | `fallow explain <issue-type>`                |
