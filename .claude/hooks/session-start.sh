#!/bin/bash
# SessionStart hook: install the workspace so the quality gates
# (`bun run lint`, `bun run typecheck`, `bun run test:run`, ...) work in a
# Claude Code on the web session. Local sessions are left alone; run
# `bun install` yourself there.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# The lockfile is authoritative (`bun ci` is `bun install --frozen-lockfile`).
# Package lifecycle scripts stay off by default under bun; the root `prepare`
# script (effect-language-service patch) is ours and still runs.
bun install --frozen-lockfile
