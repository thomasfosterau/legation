# Claude Code

Read the README, docs/CONTRIBUTING.md and AGENTS.md (imported below) first.

- `.claude/settings.json` runs `vp fmt --write` on every file you write or edit. The fallow gate is the git pre-commit hook (`vp run fallow:audit`), not a Claude hook.
- Work in a git worktree under `.claude/worktrees/` (gitignored), one per branch, and run `vp install --frozen-lockfile` in it first.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
