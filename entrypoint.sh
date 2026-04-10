#!/bin/bash
set -e

# Source user environment variables if available
if [ -f ~/.exports ]; then
    # shellcheck disable=SC1090
    source ~/.exports
fi

# Install/update packages (non-blocking)
pi install git:github.com/myk-org/pi-config 2>/dev/null || true
pi install git:github.com/skyfallsin/pi-vertex-anthropic 2>/dev/null || true
pi update 2>/dev/null || true

exec pi "$@"
