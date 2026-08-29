#!/usr/bin/env bash
# Build pidash-ui and pidiff-ui dist/ for npm pack / publish.
# dist/ is gitignored; package.json files lists it so a pre-publish build ships.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

build_ui() {
  local ui_dir="$1"
  echo "Building ${ui_dir}..." >&2
  cd "${REPO_DIR}/${ui_dir}"
  if [ ! -d node_modules ]; then
    npm install --production=false >&2
  fi
  npm run build >&2
}

build_ui extensions/pidash/pidash-ui
build_ui extensions/pidiff/pidiff-ui

echo "UI builds complete." >&2
echo "  ${REPO_DIR}/extensions/pidash/pidash-ui/dist/index.html" >&2
echo "  ${REPO_DIR}/extensions/pidiff/pidiff-ui/dist/index.html" >&2
