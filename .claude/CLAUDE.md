# Claude Code in legation

This file holds only what is specific to Claude Code. The project's general guidance is imported at the end: agent guidance from `AGENTS.md`, setup, commands and pull-request rules from `CONTRIBUTING.md`, and the overview and package table from `README.md`. Each package's own guidance is in `packages/<name>/AGENTS.md`, which that package's `CLAUDE.md` imports.

## Hooks (`.claude/settings.json`)

- **SessionStart** (`.claude/hooks/session-start.sh`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's allowlist). It then links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`) and runs `vp install --frozen-lockfile`. The global `vp` delegates to each checkout's own `vite-plus`, worktrees included. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for TypeScript files (the commerce example's `dev:server`). Nothing else is put on PATH. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. The hook hydrates no secrets, and none are needed. `.devcontainer/` runs the same hook.
- **PreToolUse** (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` (run through `vp exec fallow`) fails. It is the "Fallow local gate" in `AGENTS.md`, enforced. It runs only in this checkout and its `.claude/worktrees/*`; for any other tree it skips the audit with a notice and runs none of that tree's tooling. It reads the coverage map on disk, so run `vp run test:coverage` first.
- **PostToolUse** runs `vp fmt` on every source, JSON, YAML or Markdown file you write or edit.

## Sessions

- Work in a worktree under `.claude/worktrees/` (gitignored), one per branch, and run `vp install --frozen-lockfile` in it before anything else. The fallow gate trusts only those worktrees and this checkout.
- Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.
- The commerce browser test needs Chromium, which a cloud session may not be able to download (see "Verification" in `AGENTS.md` for the fallback and what to say in the PR body).

## Skills

The vendored skills in `.claude/skills/` read their repo config from `docs/agents/`: `issue-tracker.md` (gh conventions), `triage-labels.md` (the label strings) and `domain.md` (which docs to read).

---

@../AGENTS.md

@../CONTRIBUTING.md

@../README.md
