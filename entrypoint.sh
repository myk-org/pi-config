#!/bin/bash
set -e

# Install or update packages
PI_PKG_DIR="$HOME/.pi/agent/git/github.com"

if [ ! -d "$PI_PKG_DIR/myk-org/pi-config" ]; then
    pi install git:github.com/myk-org/pi-config
else
    pi update git:github.com/myk-org/pi-config
fi

if [ ! -d "$PI_PKG_DIR/isaacraja/pi-vertex-claude" ]; then
    pi install git:github.com/isaacraja/pi-vertex-claude
else
    pi update git:github.com/isaacraja/pi-vertex-claude
fi

# pi-web-access: register in pi settings if not already present
# (installed globally in Docker image, just needs pi to know about it)
if ! grep -q 'pi-web-access' "$HOME/.pi/agent/settings.json" 2>/dev/null; then
    pi install npm:pi-web-access 2>/dev/null || true
fi

# agent-browser skill (link to installed npm package)
SKILL_DIR="$HOME/.pi/agent/skills/agent-browser"
if [ ! -d "$SKILL_DIR" ]; then
    mkdir -p "$(dirname "$SKILL_DIR")"
    ln -sf /usr/local/lib/node_modules/agent-browser/skills/agent-browser "$SKILL_DIR"
fi

# Fix host-specific paths in mounted .gitconfig (read-only mount, can't write in-place)
cp /home/node/.gitconfig /home/node/.gitconfig-local 2>/dev/null || true
if [ -f /home/node/.gitconfig-local ]; then
    export GIT_CONFIG_GLOBAL=/home/node/.gitconfig-local
    git config --global core.excludesFile /home/node/.gitignore-global
fi

exec pi "$@"
