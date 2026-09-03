#!/bin/bash
# Main entrypoint — runs as node user (dropped from root by init-entrypoint.sh).
# HOME is set to /home/$PI_HOST_USER if configured, otherwise /home/node.
set -e

# Always install/update pi, acpx, and mcpc on every container start.
# PI_HOST_USER can reverse-symlink the host ~/.npm-global over the image copy.
npm install -g @earendil-works/pi-coding-agent
npm install -g acpx
npm install -g @apify/mcpc 2>/dev/null || true

# Install https://github.com/dietrichgebert/ponytail
pi install git:github.com/DietrichGebert/ponytail

# Install https://github.com/rtk-ai/rtk
rtk init -g --agent pi

# Register pi packages if not already present — single mechanism for all of
# them. `legacy_marker` catches a stale pre-npm source (e.g. vertex's old
# racing git-subdir registration) and actively migrates it to npm instead of
# leaving it in place.
register_pi_pkg() {
  local source="$1" legacy_marker="${2:-}"
  # Quoted JSON token so git:…/pi-config does not match git:…/pi-config/packages/…
  if [ -n "$legacy_marker" ] && grep -qF "\"${legacy_marker}\"" "$HOME/.pi/agent/settings.json" 2>/dev/null; then
    pi uninstall "$legacy_marker" 2>/dev/null || true
  fi
  if grep -qF "npm:${source}" "$HOME/.pi/agent/settings.json" 2>/dev/null; then
    return 0
  fi
  pi install "npm:$source" 2>/dev/null || true
}
register_pi_pkg pi-orchestrator-config "git:github.com/myk-org/pi-config"
register_pi_pkg "@myk-org/pi-vertex-claude" "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
register_pi_pkg pi-web-access

# Update all installed packages + myk-pi-tools (PyPI — no git source).
pi update --all
uv tool install --force myk-pi-tools 2>/dev/null || true

# Fix host-specific paths in mounted .gitconfig (read-only mount, can't write in-place)
# Always create a writable local copy so git config --global never writes to a read-only mount
cp "$HOME/.gitconfig" "$HOME/.gitconfig-local" 2>/dev/null || touch "$HOME/.gitconfig-local"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig-local"

# Ensure gitignore is writable (host file may be read-only mounted)
# Resolve source: normalize ~ prefix, try configured path then known defaults
GITIGNORE_SRC="$(git config --global core.excludesFile 2>/dev/null || true)"
case "$GITIGNORE_SRC" in ~/*) GITIGNORE_SRC="$HOME/${GITIGNORE_SRC#\~/}" ;; esac
if [ -z "$GITIGNORE_SRC" ] || [ ! -r "$GITIGNORE_SRC" ]; then
  for candidate in "$HOME/.gitignore-global" "$HOME/.config/git/ignore"; do
    if [ -r "$candidate" ]; then
      GITIGNORE_SRC="$candidate"
      break
    fi
  done
fi
GITIGNORE_LOCAL="$HOME/.gitignore-local"
if [ -n "$GITIGNORE_SRC" ] && [ -r "$GITIGNORE_SRC" ]; then
  cp "$GITIGNORE_SRC" "$GITIGNORE_LOCAL"
else
  touch "$GITIGNORE_LOCAL"
fi
git config --global core.excludesFile "$GITIGNORE_LOCAL"

# SSH timeout — detect dead connections during git fetch/push/pull
# ServerAliveInterval: send keepalive every 15s
# ServerAliveCountMax: give up after 3 missed responses (45s total)
# ConnectTimeout: fail if can't connect within 10s
export GIT_SSH_COMMAND="ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10"

# Ensure required entries are in global gitignore
add_to_gitignore() {
  if ! grep -qxF "$1" "$GITIGNORE_LOCAL" 2>/dev/null; then
    echo "$1" >>"$GITIGNORE_LOCAL"
  fi
}
add_to_gitignore '.pi/'
add_to_gitignore '.worktrees/'
# CLI specialist agents materialised under the mounted project (see symlink-cli-specialists.sh)
add_to_gitignore '.cursor/agents/'
add_to_gitignore '.claude/agents/'
add_to_gitignore '.gemini/agents/'

# Symlink package agents into PWD for Cursor/Claude/Gemini discovery (container only).
# Source is the npm unpack of pi-orchestrator-config — never a git clone.
# Native users place these manually — see README / cli-provider.md.
# Failures are warn-only: container start must not abort if linking fails.
PI_NPM_PKG="$HOME/.pi/agent/npm/node_modules/pi-orchestrator-config"
AGENTS_SRC="$PI_NPM_PKG/agents"
SYMLINK_SCRIPT="$PI_NPM_PKG/scripts/symlink-cli-specialists.sh"
if [ -d "$AGENTS_SRC" ] && [ -x "$SYMLINK_SCRIPT" ]; then
  if ! "$SYMLINK_SCRIPT" "$AGENTS_SRC" "$PWD"; then
    echo "WARN: failed to symlink CLI specialists from $AGENTS_SRC" >&2
  fi
elif [ -d "$AGENTS_SRC" ] && [ -f "$SYMLINK_SCRIPT" ]; then
  if ! bash "$SYMLINK_SCRIPT" "$AGENTS_SRC" "$PWD"; then
    echo "WARN: failed to symlink CLI specialists from $AGENTS_SRC" >&2
  fi
else
  echo "WARN: pi-orchestrator-config npm tree missing at $PI_NPM_PKG — skip CLI specialist symlinks" >&2
fi

exec pi "$@"
