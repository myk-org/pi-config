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

# pi-web-access: register in pi settings if not already present
# (installed globally in Docker image, just needs pi to know about it)
if ! grep -q 'pi-web-access' "$HOME/.pi/agent/settings.json" 2>/dev/null; then
    pi install npm:pi-web-access 2>/dev/null || true
fi


# Fix host-specific paths in mounted .gitconfig (read-only mount, can't write in-place)
cp "$HOME/.gitconfig" "$HOME/.gitconfig-local" 2>/dev/null || true
if [ -f "$HOME/.gitconfig-local" ]; then
    export GIT_CONFIG_GLOBAL="$HOME/.gitconfig-local"
    git config --global core.excludesFile "$HOME/.gitignore-global"
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


exec pi "$@"
