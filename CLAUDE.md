# Project Instructions

## Repository layout

This is a bun-workspaces monorepo of Effect-based sync-engine packages under `packages/` (`effect`, `browser`, `node`, `jsonapi`, `sql`, `react`, `svelte`). Package boundaries are dependency-based: everything that needs only `effect` lives in `effect` (the engine core); protocol/runtime/framework adapters get their own packages (ADR-0006). Read `CONTEXT.md` for the domain glossary and `docs/adr/` for architecture decisions before making changes. Quality gates: `bun run build`, `bun run typecheck`, `bun run test:run`, `bun run lint`, `bun run format:check`.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

**If `effect-solutions` is unavailable** (e.g. in CI or remote containers): this repo targets the **Effect v4 release-candidate line**, whose APIs differ from v3 and from most online docs. Verify any uncertain API against the installed type definitions in `node_modules/effect/dist/*.d.ts` before using it.

<!-- effect-solutions:end -->

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-docs layout (root `CONTEXT.md` plus `docs/adr/`). See `docs/agents/domain.md`.
