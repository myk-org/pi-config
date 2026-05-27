#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="${HOME}/.pi/cache/pi-vs-claude-code"
REPO_URL="https://github.com/disler/pi-vs-claude-code.git"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${SCRIPT_DIR}/../extensions/orchestrator/upstream-coms"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

# Source files (relative to clone root) → flat copy into DEST_DIR
SOURCE_FILES=(
    "extensions/coms.ts"
    "extensions/coms-net.ts"
    "extensions/themeMap.ts"
    "scripts/coms-net-server.ts"
)

# --- Cache management ---

if [[ "$FORCE" -eq 1 ]] && [[ -d "$CACHE_DIR" ]]; then
    rm -rf "$CACHE_DIR"
fi

if [[ -d "$CACHE_DIR" ]]; then
    git -C "$CACHE_DIR" pull --ff-only --quiet 2>/dev/null || {
        echo "Error: git pull failed in cache dir ${CACHE_DIR}" >&2
        exit 1
    }
else
    mkdir -p "$(dirname "$CACHE_DIR")"
    git clone --depth 1 --quiet "$REPO_URL" "$CACHE_DIR" 2>/dev/null || {
        echo "Error: git clone failed for ${REPO_URL}" >&2
        exit 1
    }
fi

# --- Validate source files exist ---

for f in "${SOURCE_FILES[@]}"; do
    if [[ ! -f "${CACHE_DIR}/${f}" ]]; then
        echo "Error: expected file not found in upstream: ${f}" >&2
        exit 1
    fi
done

# --- Copy files ---

mkdir -p "$DEST_DIR"

copied=0
for f in "${SOURCE_FILES[@]}"; do
    cp "${CACHE_DIR}/${f}" "${DEST_DIR}/$(basename "$f")"
    copied=$((copied + 1))
done

# --- Patch imports ---

for f in "${DEST_DIR}"/*.ts; do
    sed -i \
        -e 's|@mariozechner/pi-coding-agent|@earendil-works/pi-coding-agent|g' \
        -e 's|@mariozechner/pi-tui|@earendil-works/pi-tui|g' \
        -e 's|@sinclair/typebox|typebox|g' \
        "$f"
done

# --- Patch detect-secrets false positives (Crockford Base32 alphabet) ---

for f in "${DEST_DIR}"/*.ts; do
    sed -i 's|const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";|const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // pragma: allowlist secret|g' "$f"
done

# --- Summary ---

short_hash="$(git -C "$CACHE_DIR" rev-parse --short HEAD)"
echo "Synced ${copied} files from upstream (commit: ${short_hash})"
