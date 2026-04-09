#!/bin/bash
set -e

# Source user environment variables if available
if [ -f ~/.exports ]; then
    # shellcheck disable=SC1090
    source ~/.exports
fi

# Install pi-config package (non-blocking)
pi install git:github.com/myk-org/pi-config || \
    echo 'WARNING: pi install failed, starting pi without package' >&2

exec pi --approve-all "$@"
