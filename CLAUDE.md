# CLAUDE.md

`AGENTS.md` is a symlink to this file. legation publishes the `@thomasfosterau/legation-*` packages, an Effect v4 (release-candidate line) sync engine and its runtime, protocol and framework adapters. It is a **bun** workspace, not the programme's pnpm + Vite+: every command is a `bun run` script, and versions live in the root Bun catalog (`package.json` → `workspaces.catalog`) plus `overrides` (which pins the transitive `@effect/platform-node-shared` to the same version). Read `CONTEXT.md` (the glossary) and the `docs/adr/` entries for the area you touch before changing it.

| Package                               | Directory             | Purpose / boundary                                                                                                 |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@thomasfosterau/legation-effect`     | `packages/effect`     | Engine core. App surface on `.`, engine seams for adapter authors on `./internal` (ADR-0022). Peer: `effect` only. |
| `@thomasfosterau/legation-browser`    | `packages/browser`    | Service-worker / elected host, IndexedDB client store, tab mirrors, Cache API HTTP cache.                          |
| `@thomasfosterau/legation-node`       | `packages/node`       | `HttpSyncServer`: the RPC sync transport on Node HTTP/WebSocket.                                                   |
| `@thomasfosterau/legation-jsonapi`    | `packages/jsonapi`    | JSON:API loaders, derived sync, façade (over `@thomasfosterau/effect-jsonapi`).                                    |
| `@thomasfosterau/legation-sql`        | `packages/sql`        | SQL reference `Backend` over a `SqlExecutor` seam.                                                                 |
| `@thomasfosterau/legation-cloudflare` | `packages/cloudflare` | Durable Object rooms, fan-out shards, D1 executor.                                                                 |
| `@thomasfosterau/legation-svelte`     | `packages/svelte`     | Rune hooks; SvelteKit surface on `./kit`.                                                                          |
| `@thomasfosterau/legation-devtools`   | `packages/devtools`   | Headless devtools core; Svelte panel on `./svelte` (ships raw `.svelte` source).                                   |

## Common pitfalls

- **Code that needs only `effect` goes in `packages/effect`**; runtime-, protocol- or framework-specific code gets its own package (ADR-0006), so the core runs identically in browsers, workers, edge runtimes and Node.
- **App-facing names go on `@thomasfosterau/legation-effect`, engine seams on `@thomasfosterau/legation-effect/internal`** (ADR-0022). Import accordingly in docs, READMEs and examples: `ClientEngine`, `Subset`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo` and the other seams are not on the root entry, so a sample that imports them from it doesn't compile.
- **`effect` is a peer, never a dependency**: two copies break `Context` identity. The dev pin lives once in the root catalog; the published floor is the open range in each package's `peerDependencies`. To move either, follow CONTRIBUTING.md "Effect version upgrades".
- **Publish only through `bun run release` (`scripts/release.ts`)**, never with `npm publish`, `npm publish --workspaces` or a bare `changeset publish`: npm copies `workspace:^` and `catalog:` into the packed `package.json` verbatim, so the dependent packages would ship uninstallable manifests. The script packs with `bun pm pack` (which rewrites both) and uploads with `npm publish <tarball>`, because `bun publish` has no npm OIDC trusted publishing ([#267](https://github.com/thomasfosterau/legation/issues/267)). `bun pm pack` takes internal ranges from `bun.lock`, not `package.json`, so `bun.lock` must carry the bumped versions: `bun run version` runs `bun install --lockfile-only` after `changeset version`, and `release:check` fails on a stale lock.

## Conventions

- **Relative imports carry the `.js` extension** (`NodeNext` resolution); each package's `src/index.ts` re-exports its modules as namespaces (`export * as Node from "./Node.js"`).
- **`exactOptionalPropertyTypes` is on**: an optional field a caller may forward `undefined` to is spelled `?: T | undefined`.
- **Every export a consumer sees starts its doc comment with a one-sentence summary**, before any tag: hover shows only that text. Write ``@throws `X` when …``, never `@throws {@link X}`, which TypeScript misparses.
- Service, error and test conventions are in CONTRIBUTING.md ("Effect Code", "Tests").

## Commands

- `bun install --frozen-lockfile` (`bun ci`): install from the lockfile.
- **TypeScript is split 6/7.** `typescript` (catalog, exact 6.0.2) is the JS-API compiler that svelte-check, the Effect language service and Vite load; `@typescript/native` (TS 7) runs `build` and `typecheck`, invoked as `node node_modules/@typescript/native/bin/tsc` because both packages ship a `tsc` bin and bun's `.bin/tsc` choice is not a contract. The root `prepare` script runs `effect-tsgo patch --typescript`, which patches that native compiler so Effect diagnostics (e.g. `floatingEffect`) fail `build` and `typecheck`; `@effect/tsgo` and `@typescript/native` must move together (read the `components` table in `node_modules/@effect/tsgo/dist/effect-tsgo.cjs`). The `@typescript/typescript6` alias used by the pnpm repos does not install under bun (its nested `@typescript/old` alias collapses into the root `typescript` entry), so TS 6 is the plain package.
- `bun run build`: build every package (tsc project references). `bun run typecheck:examples` resolves the packages through `dist/`, so build first.
- `bun run release:check`: pack every publishable package with `bun pm pack` and fail on a `workspace:` / `catalog:` specifier left in a packed `package.json`, an internal range that doesn't match the dependency's `package.json` version (a stale `bun.lock`), an exact `effect` / `@effect/*` peer, a `svelte` export condition naming a file that isn't packed, or a `publint` (strict) or `attw` (ESM-only: `node10` and `node16-cjs` ignored) finding on the packed tarball. Fix a finding; suppress one only in `attwSuppressions` in `scripts/release.ts`, with its reason. Needs `bun run build` first. No registry access.
- `bun run typecheck`: packages and tests. `bun run typecheck:examples`: each example app's own `tsc` / `svelte-check`.
- `bun run test:run`: every Vitest suite (needs Chromium; see Agent sessions). `bunx vitest run packages/<name>` runs one package's tests without a build (Vitest aliases to source).
- `bun run lint` (Oxlint) and `bun run format:check` (Prettier). Fix with `bun run lint:fix` / `bun run format`.
- `bun run analyze:audit:ci`: the fallow audit against `origin/trunk`, using the coverage map `bun run test:coverage` writes. Fetch `origin/trunk` first.
- `bun run changeset`: add a changeset.

## Verification

Before you report work as done, run these in CI's order (`.github/workflows/ci.yml`) and quote each command with its final pass/fail:

1. `bun run format:check`
2. `bun run lint`
3. `bun run build`
4. `bun run release:check`
5. `bun run typecheck`
6. `bun run typecheck:examples`
7. `bun run test:coverage` (the suite plus the coverage map the audit reads)
8. `bun run analyze:audit:ci`

If a gate can't run here, say which and why in the PR body; never imply it ran.

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`; squash-merge. Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Add a changeset (`bun run changeset`) for every user-facing or package-impacting change, naming each package it touches; docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it.
- Standing approvals: once a branch has a pushed commit, open its PR without being asked; watch it to merge or close, investigating CI failures and review comments as they arrive; keep its body current with what the branch does.
- GitHub writes go to `thomasfosterau/legation` only; pass `-R thomasfosterau/legation` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

GitHub Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. The issue is the spec: read it with `gh issue view <n> --comments`; later comments override the body. Record decisions and findings as issue comments. Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop. Scope cut mid-PR becomes a linked issue before merge.

The vendored skills in `.claude/skills/` read their repo config from `docs/agents/`: `issue-tracker.md` (gh conventions), `triage-labels.md` (the label strings) and `domain.md` (which docs to read).

## Effect

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

<!-- effect-solutions:end -->

If `effect-solutions` is unavailable (the SessionStart hook doesn't install it), verify any uncertain API against `node_modules/effect/dist/*.d.ts`: this repo is on the Effect v4 release-candidate line (the pin in the root `package.json` catalog), whose APIs differ from v3 and from most online docs. On that line HTTP lives at `effect/http/*` and RPC at `effect/rpc`; there are no `effect/unstable/*` paths.

## Agent sessions

- `.claude/hooks/session-start.sh` (the SessionStart hook) runs `bun install --frozen-lockfile` in Claude Code on the web sessions only (`CLAUDE_CODE_REMOTE=true`); run it yourself locally. It hydrates no secrets, and none are needed.
- `bun run test:run` and `bun run test:coverage` need Chromium for the commerce façade's browser test, which fails rather than skips without it. Run `bunx playwright-core install chromium` first; if the download is blocked, run `bunx vitest run packages` and say in the PR body that the commerce browser test didn't run.

## Documentation surfaces

- `CONTEXT.md`: the domain glossary. `docs/adr/`: architecture decisions (historical records; fix only a wrong status or path).
- Package `README.md`: the npm-facing API reference. Links into the repo stay relative (npm rewrites them against `repository`), but a consumer must not need them: everything they need is in the README.
- `CONTRIBUTING.md`: setup, commands, conventions, Effect upgrades, the release pipeline and the owner's one-time setup.
- `docs/agents/`: config the vendored skills read. Decisions and findings go in issue comments.
