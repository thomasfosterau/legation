# AGENTS.md

Guidance for coding agents working in legation. It covers conventions, pitfalls, verification and the work tracker. Claude Code reads it through `.claude/CLAUDE.md`, which imports this file along with `CONTRIBUTING.md` and `README.md`.

The project overview and the package table (each package's entries and boundary) are in [README.md](README.md#packages). Setup, the command reference and the branch, pull-request and changeset rules are in [CONTRIBUTING.md](CONTRIBUTING.md). legation is a **pnpm 11 + Vite+ (`vp`)** workspace: versions live in the `pnpm-workspace.yaml` catalogs, and every gate is a `vp` command or a `vp run` task defined in `vite.config.ts`.

Before changing an area, read:

- `CONTEXT.md` (the glossary);
- the `docs/adr/` entries for that area;
- the package's own `AGENTS.md` (`packages/<name>/AGENTS.md`), for its boundary and invariants.

## Common pitfalls

- **Code that needs only `effect` goes in `packages/effect`**; code that imports another package (the owner's own libraries included: `@thomasfosterau/effect-jsonapi`, `@thomasfosterau/effect-svelte`) or a framework gets its own package. A runtime platform is not a dependency (ADR-0033, superseding ADR-0006 in part), but the core still imports no runtime (`node:*`, DOM beyond the `WebWorker` lib), so it runs identically in browsers, workers, edge runtimes and Node; an `effect`-only module most apps don't need goes on an entry of its own (`./sql`). Provider and integration packages are merged or split by the owner, case by case. `.fallowrc.json`'s boundaries enforce the package dependency graph.
- **App-facing names go on `@thomasfosterau/legation`, engine seams on `@thomasfosterau/legation/internal`** (ADR-0022). Import accordingly in docs, READMEs and examples: `ClientEngine`, `Subset`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo` and the other seams are not on the root entry, so a sample that imports them from it doesn't compile.
- **`effect` is a peer, never a dependency**: two copies break `Context` identity. The dev pin is the catalog's `effect` entry (with every `@effect/*` runtime package at the same version, and `overrides` forcing the singleton); the published floor is `catalogs.peers.effect`. The `effect` peer (and each `@effect/*` peer) is `^4.0.0`; raise it, per package, only when a dependency of that package requires it, in a named catalog whose comment names the dependency (`catalogs.alchemy-peers`, legation-alchemy-cloudflare's `^4.1.0`, forced by `alchemy`; `catalogs.auth-peers`, legation-auth's `^4.1.0`, forced by `@thomasfosterau/effect-auth`). Our own code is written to run on 4.0.0. Each floor is tested in CI by its own job ("Tests (effect floor, …)"), so a package with its own floor keeps its tests in a Vitest project of its own (`alchemy-cloudflare`, `auth`). To move either, follow CONTRIBUTING.md "Effect version upgrades".
- **Dependabot groups only the lockstep sets** (`.github/dependabot.yml`: `toolchain`, `effect`, `svelte`, `alchemy`; everything else, `@enfect/oxlint` and each GitHub Action included, gets its own PR) with a 1-day `cooldown`, longer than pnpm's 480-minute `minimumReleaseAge`. By hand, on the matching PR: the npm-alias entries (`vite`, `typescript`, `@typescript/native`), the `overrides` keys, `catalogs.peers` and `catalogs.*-peers` (the exact Alchemy peers included), and an `@effect/tsgo` that supports a new vite-plus's oxlint.
- **The Alchemy adapter is written against the provider's services** (`@alchemy.run/cloudflare`'s `Workers` and `D1` modules), never raw workerd types, and the app declares its Durable Object classes; the package exports the implementations (ADR-0034, `packages/alchemy-cloudflare/AGENTS.md`).
- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalogs (`catalogMode: strict`); manifests carry only `catalog:`, `catalog:peers` and `workspace:` specifiers. After editing a catalog, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `vite-plus`, `@effect/tsgo` and `@typescript/native` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **`dist/` is the product.** Each package is a `vp pack` (tsdown) library emitting one module per source module (`unbundle`: a consumer's bundler drops what it doesn't reach, which it can't inside a merged chunk, #678); `exports` points at `dist/`, so the example apps and the commerce browser test consume it the way a consumer does. Tests and `vp run check` resolve the package names to `src/` instead (the root `vite.config.ts` aliases, `tsconfig.check.json` `paths`), so neither needs a build first.
- **Publish only through the Release workflow** (`pnpm run release` → `scripts/publish.mjs`), never `npm publish` in a package directory: npm copies `workspace:` and `catalog:` into the published `package.json` verbatim (#267). `pnpm pack` rewrites them, and `scripts/pack.mjs` checks the tarball (publint strict, attw ESM-only, no exact `effect` peer, `svelte` conditions packed) before `npm publish <tarball>` uploads it under OIDC.

## Conventions

- **Relative imports carry the `.js` extension** (`NodeNext` resolution); each package's `src/index.ts` re-exports its modules as namespaces (`export * as Node from "./Node.js"`).
- **Effect modules are imported as namespaces from their submodule** (`import * as Effect from "effect/Effect"`), never as named imports from the `effect` barrel. The helper modules take the canonical aliases: `Arr` (`effect/Array`), `P` (`effect/Predicate`), `R` (`effect/Record`), `Str` (`effect/String`), `Eq` (`effect/Equal`) and `Bool` (`effect/Boolean`), and `Option` and `Schema` keep their own names. `effect/prefer-namespace-imports` enforces this at `error` in `packages/*`, and in the example apps through `vp run lint:examples` (part of `check:examples`), the one rule of the library lint they run.
- **`exactOptionalPropertyTypes` is on**: an optional field a caller may forward `undefined` to is spelled `?: T | undefined`.
- **Tests import from `@effect/vitest` or `vite-plus/test`**, never `vitest`. Service, error and test conventions are in CONTRIBUTING.md ("Effect Code", "Tests").
- **Every export a consumer sees starts its doc comment with a one-sentence summary**, before any tag: hover shows only that text. Write ``@throws `X` when …``, never `@throws {@link X}`, which TypeScript misparses.
- **Invoke everything through `vp`**, as [CONTRIBUTING.md "Commands"](CONTRIBUTING.md#commands) lists it: `vp exec` instead of `npx`, `vp run <task>` instead of a bare `pnpm` script.

## Verification

Before you report work as done, run these in CI's order (`.github/workflows/ci.yml`, job "Quality Gates") and quote each command with its final pass/fail:

1. `vp check`
2. `vp run build`
3. `vp run pack:check`
4. `vp run check`
5. `vp run check:examples`
6. `vp run test:coverage` (the suite plus the coverage map the audit reads; needs Chromium, and `DATABASE_URL` for the PostgreSQL overlap test)
7. `pnpm audit --audit-level high` (network)
8. `vp exec fallow audit --base origin/trunk` (fetch `origin/trunk` first)

CI also runs the suite at the published `effect` floor ("Tests (effect floor)"). If a gate can't run here, say which and why in the PR body; never imply it ran.

The commerce façade's browser test fails, rather than skips, without Chromium: run `pnpm exec playwright-core install chromium` first. If the download is blocked, run `vp test run --project node --project svelte` and say in the PR body that the commerce browser test didn't run. The PostgreSQL overlap test skips locally without `DATABASE_URL` (CI sets it).

## Pull requests

The branch, rebase, squash-merge and changeset rules are in [CONTRIBUTING.md "Branches and pull requests"](CONTRIBUTING.md#branches-and-pull-requests). For agents:

- Standing approvals: once a branch has a pushed commit, open its PR without being asked; watch it to merge or close, investigating CI failures and review comments as they arrive; keep its body current with what the branch does.
- GitHub writes go to `thomasfosterau/legation` only; pass `-R thomasfosterau/legation` whenever the cwd might be another checkout.
- Never publish or version by hand: the Release workflow opens the "chore: version packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).

## Work tracker

GitHub Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. The issue is the spec: read it with `gh issue view <n> --comments`; later comments override the body. Record decisions and findings as issue comments. Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop. Scope cut mid-PR becomes a linked issue before merge.

## Effect

Never guess at an Effect API. This repo is on the Effect v4 release-candidate line, whose APIs differ from v3 and from most online docs; the pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog. Read the installed package: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` (the pinned version ships both), the declarations in `node_modules/effect/dist/*.d.ts`, and the source in `node_modules/effect/src/`.

- On this line HTTP lives at `effect/http/*` and RPC at `effect/rpc`; there are no `effect/unstable/*` paths.
- The Effect lint presets (`@effect/tsgo`'s and `@enfect/oxlint`'s `recommended`) run in `vp check`. A rule at `warn` under "ported-code allowances" in `vite.config.ts` carries the count left when the presets were adopted (the sites are listed in [#497](https://github.com/thomasfosterau/legation/issues/497)): a new site is a defect, not headroom, and a rule whose count reaches zero has its line deleted so it is back at `error`.

## Documentation surfaces

- `README.md`: the landing page, with the project overview and the package table. Package `README.md`: the npm-facing API reference. Links into the repo stay relative (npm rewrites them against `repository`), but a consumer must not need them: everything they need is in the README.
- `AGENTS.md` (this file): general agent guidance. Package `AGENTS.md`: the package's boundary, invariants and terms (not published). Each `CLAUDE.md` (`.claude/CLAUDE.md` at the root, `packages/<name>/CLAUDE.md`) holds only Claude Code-specific instructions and imports the general files with `@path`, so nothing is written twice.
- `CONTEXT.md`: the domain glossary. `docs/adr/`: architecture decisions (historical records; fix only a wrong status or path, and record a new decision as a new ADR).
- `CONTRIBUTING.md`: setup, commands, branches and pull requests, hooks, individual checks, Effect upgrades. `PUBLISHING.md`: the release pipeline and the owner's one-time setup. `SECURITY.md`: the reporting channel and supply-chain posture.
- `docs/agents/`: config the vendored agent skills read (`issue-tracker.md`, `triage-labels.md`, `domain.md`). Decisions and findings go in issue comments.

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
