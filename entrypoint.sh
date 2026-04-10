#!/bin/bash
set -e

# Point agent-browser at Playwright's Chromium
if [ -z "$AGENT_BROWSER_EXECUTABLE_PATH" ] && [ -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
    CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name chrome -type f -path "*/chrome-linux/*" 2>/dev/null | head -1)
    if [ -n "$CHROME_BIN" ]; then
        export AGENT_BROWSER_EXECUTABLE_PATH="$CHROME_BIN"
    fi
fi

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

exec pi "$@"
