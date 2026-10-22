#!/usr/bin/env bash
#
# Provision a checkout for NON-INTERACTIVE use.
#
# Run by the Claude Code SessionStart hook (.claude/settings.json).
#
# ## The problem it solves
#
# `~/.bashrc` opens with Debian's standard guard:
#
#     case $- in
#         *i*) ;;
#           *) return;;
#     esac
#
# and the line that puts the toolchain on PATH — `. "$HOME/.vite-plus/env"` —
# sits *below* it. So the environment is correct for a human at a prompt and
# broken for every non-interactive shell, which is what an agent's tool calls
# and a git hook both are. `fallow` (the PreToolUse fallow gate runs it before
# every agent `git commit` / `git push`) and `tsx` (the commerce example's sync server)
# are in `node_modules/.bin`, which is on nobody's PATH.
#
# Rather than fight PATH — which this script cannot export into its caller —
# it links the tools into `~/.local/bin`, a directory already on PATH in this
# image and writable by the session user. A symlink survives where an `export`
# cannot.
#
# ## Node, and why this repairs rather than clobbers
#
# `~/.vite-plus/bin/node` is a shim pointing at the `vp` launcher, which
# resolves a Node version and installs it under `~/.vite-plus/js_runtime`. That
# directory is `root:root` from image build while the session user is `vp`, so
# when the resolved version drifts past the cached one the shim fails:
#
#     vp: Failed to install Node 24.19.0: Permission denied (os error 13)
#
# Anything routed through `vp` still works; bare `node` does not — which breaks
# the pre-commit hook repo-wide, because `vp staged` shells out to it (gardeneria #1462).
# There is no root in a session, so the directory cannot be chowned here.
#
# This script therefore *tests* `node --version` and only replaces the shim
# when it is already broken, pointing it at a real cached binary. A working
# shim is left alone, so `vp env use` keeps functioning wherever it functions
# today. The repair is deliberately conditional: unconditionally replacing a
# working shim would trade one breakage for another.
#
# ## Secrets
#
# This hook hydrates no secrets; nothing in this repo needs one. The commerce
# façade's browser test also needs Chromium, which this hook does not fetch
# (`pnpm exec playwright-core install chromium`; AGENTS.md "Agent sessions").
#
# ## Contract
#
# Idempotent, and never fatal. Every failure path logs and continues, because
# the SessionStart hook must not block a session and a half-provisioned
# session is more useful than one that refused to start. Callers
# that want hard failure should check the tools themselves afterwards.
#
# Untrusted-content note: this script reads only fixed, hardcoded paths. It
# takes no input from repo content, issue or PR bodies, or anything an agent
# could have been persuaded to write earlier in a session. Do not add such
# input without revisiting this note — it runs on every session start.

set -uo pipefail

log() { printf '[session-start] %s\n' "$1" >&2; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOCAL_BIN="${HOME:-/home/vp}/.local/bin"

mkdir -p "$LOCAL_BIN" 2>/dev/null || log "cannot create $LOCAL_BIN; continuing"

# Link a binary into ~/.local/bin, replacing a stale link but never a real file.
link_tool() {
  src="$1"
  name="$(basename "$src")"
  dest="$LOCAL_BIN/$name"
  [ -x "$src" ] || return 0
  # Leave a real (non-symlink) binary alone: something deliberately installed it.
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    return 0
  fi
  ln -sfn "$src" "$dest" 2>/dev/null || log "could not link $name"
}

# `vp` gets a re-exec shim rather than a plain symlink. A symlink always
# resolves to $PROJECT_DIR's node_modules/vite-plus, even when invoked with
# cwd inside a `.claude/worktrees/*` checkout — so the CLI process loads the
# primary tree's vitest while the worktree's test modules resolve the
# worktree's own copy. Two physical instances of the same vitest version
# corrupt its module-level suite-collector state, and every describe() in the
# worktree throws `Cannot read properties of undefined (reading 'config')`
# (gardeneria #1663). The shim instead walks up from $PWD for the nearest project-local
# vite-plus and re-execs that, falling back to the primary checkout's when
# none is found above cwd.
VP_SHIM_MARKER="# generated-by: .claude/hooks/session-start.sh (vp re-exec shim, gardeneria issue #1663)"
VP_SHIM_MARKER_LEGACY="# generated-by: scripts/setup-dev-env.sh (vp re-exec shim, gardeneria issue #1663)"
write_vp_shim() {
  dest="$LOCAL_BIN/vp"
  # Leave a real, non-generated file alone: something deliberately installed
  # it. A stale symlink or a shim we generated earlier (under either home) is
  # fair game to regenerate — the embedded fallback path can change across
  # containers.
  if [ -e "$dest" ] && [ ! -L "$dest" ] \
    && ! grep -qF "$VP_SHIM_MARKER" "$dest" 2>/dev/null \
    && ! grep -qF "$VP_SHIM_MARKER_LEGACY" "$dest" 2>/dev/null; then
    return 0
  fi
  cat >"$dest.tmp" <<SHIM
#!/usr/bin/env bash
$VP_SHIM_MARKER
dir="\$PWD"
while [ -n "\$dir" ]; do
  if [ -x "\$dir/node_modules/vite-plus/bin/vp" ]; then
    exec "\$dir/node_modules/vite-plus/bin/vp" "\$@"
  fi
  [ "\$dir" = "/" ] && break
  dir="\$(dirname "\$dir")"
done
exec "$PROJECT_DIR/node_modules/vite-plus/bin/vp" "\$@"
SHIM
  chmod +x "$dest.tmp" 2>/dev/null && mv -f "$dest.tmp" "$dest" 2>/dev/null \
    || { rm -f "$dest.tmp" 2>/dev/null; log "could not write vp shim"; }
}

# ── 1. Repo binaries the documented workflows invoke directly ─────────────────
# `fallow` (the PreToolUse fallow gate) and `tsx` (the commerce example's sync server) resolve
# only from node_modules/.bin. `vp` is included for the remote/web runner, where the
# global launcher does not exist.
for tool in tsx fallow; do
  link_tool "$PROJECT_DIR/node_modules/.bin/$tool"
done
write_vp_shim

# ── 2. Bare `node` (gardeneria #1462) ───────────────────────────────────────────────────
# Only repair a shim that is already failing — see the header for why this is
# conditional. `command -v node` is not enough: the shim exists and resolves,
# then dies on use, so the version call is the real test.
if ! node --version >/dev/null 2>&1; then
  VP_BIN_DIR="${VP_HOME:-${HOME:-/home/vp}/.vite-plus}/bin"
  # Newest cached runtime wins; `sort -V` so 24.9 does not beat 24.18.
  REAL_NODE="$(
    find "${VP_HOME:-${HOME:-/home/vp}/.vite-plus}/js_runtime/node" \
      -maxdepth 3 -type f -name node -perm -u+x 2>/dev/null | sort -V | tail -1
  )"
  if [ -n "$REAL_NODE" ]; then
    log "bare \`node\` is broken; pointing it at $REAL_NODE"
    # The shim lives in a vp-owned directory even though the runtime cache
    # beneath it is root-owned, so this needs no privileges.
    ln -sfn "$REAL_NODE" "$VP_BIN_DIR/node" 2>/dev/null \
      || link_tool "$REAL_NODE"
  else
    log "bare \`node\` is broken and no cached runtime was found; \`vp\`-routed commands still work"
  fi
fi

# ── 3. Dependencies ──────────────────────────────────────────────────────────
# Unconditional, not only when node_modules is absent: a prebaked container can
# carry a tree built from an OLDER lockfile, and stale dependencies masquerade
# as breakage on `trunk`. `--frozen-lockfile` is a sub-second no-op when in sync.
if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then
  log "syncing dependencies against the lockfile…"
  # pnpm comes from corepack where the image has it (it honours the
  # `packageManager` pin in package.json), else from whatever pnpm is on
  # PATH (pnpm 10+ switches itself to the pinned version).
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
  (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile >/dev/null 2>&1) \
    || (cd "$PROJECT_DIR" && vp install --frozen-lockfile >/dev/null 2>&1) \
    || log "dependency install failed; continuing"
  # node_modules/.bin only exists after the install, so re-link what it provides.
  for tool in tsx fallow; do
    link_tool "$PROJECT_DIR/node_modules/.bin/$tool"
  done
  write_vp_shim
fi

exit 0
