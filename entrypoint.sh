#!/bin/bash
# Main entrypoint — runs as node user (dropped from root by init-entrypoint.sh).
# HOME is set to /home/$PI_HOST_USER if configured, otherwise /home/node.
set -e

# Always install/update pi to get the latest version on every container start
npm install -g @earendil-works/pi-coding-agent

# Install or update packages
PI_PKG_DIR="$HOME/.pi/agent/git/github.com"

if [ ! -d "$PI_PKG_DIR/myk-org/pi-config" ]; then
    pi install git:github.com/myk-org/pi-config
else
    pi update git:github.com/myk-org/pi-config
fi

# Update myk-pi-tools to latest from local pi-config source
uv tool install --force myk-pi-tools --from "$PI_PKG_DIR/myk-org/pi-config" 2>/dev/null || true

if [ ! -d "$PI_PKG_DIR/myk-org/pi-vertex-claude" ]; then
    pi install git:github.com/myk-org/pi-vertex-claude
else
    pi update git:github.com/myk-org/pi-vertex-claude
fi

# Register pi packages if not already present
# (installed globally in Docker image, just need pi to know about them)
register_pi_pkg() {
    local name="$1" source="$2"
    if ! grep -q "$name" "$HOME/.pi/agent/settings.json" 2>/dev/null; then
        pi install "npm:$source" 2>/dev/null || true
    fi
}
register_pi_pkg pi-web-access pi-web-access
register_pi_pkg pi-tasks @tintinweb/pi-tasks



# Fix host-specific paths in mounted .gitconfig (read-only mount, can't write in-place)
cp "$HOME/.gitconfig" "$HOME/.gitconfig-local" 2>/dev/null || true
if [ -f "$HOME/.gitconfig-local" ]; then
    export GIT_CONFIG_GLOBAL="$HOME/.gitconfig-local"
    # Copy gitignore to writable location (host file may be read-only mounted)
    GITIGNORE_SRC="$(git config --global core.excludesFile 2>/dev/null || echo "$HOME/.gitignore-global")"
    GITIGNORE_LOCAL="$HOME/.gitignore-local"
    cp "$GITIGNORE_SRC" "$GITIGNORE_LOCAL" 2>/dev/null || touch "$GITIGNORE_LOCAL"
    git config --global core.excludesFile "$GITIGNORE_LOCAL"
fi

# SSH timeout — detect dead connections during git fetch/push/pull
# ServerAliveInterval: send keepalive every 15s
# ServerAliveCountMax: give up after 3 missed responses (45s total)
# ConnectTimeout: fail if can't connect within 10s
export GIT_SSH_COMMAND="ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10"

# Ensure .pi/memory/ is in global gitignore (memory DB must not be committed)
GITIGNORE_FILE="$(git config --global core.excludesFile 2>/dev/null || echo "$HOME/.gitignore-global")"
if [ -n "$GITIGNORE_FILE" ] && ! grep -qF '.pi/memory/' "$GITIGNORE_FILE" 2>/dev/null; then
    echo '.pi/memory/' >> "$GITIGNORE_FILE"
fi
if [ -n "$GITIGNORE_FILE" ] && ! grep -qF '.worktrees/' "$GITIGNORE_FILE" 2>/dev/null; then
    echo '.worktrees/' >> "$GITIGNORE_FILE"
fi
if [ -n "$GITIGNORE_FILE" ] && ! grep -qF '.pi/tasks/' "$GITIGNORE_FILE" 2>/dev/null; then
    echo '.pi/tasks/' >> "$GITIGNORE_FILE"
fi


exec pi "$@"
