#!/usr/bin/env bash
# Symlink pi package agents into project CLI discovery dirs (Cursor / Claude / Gemini).
#
# Usage: symlink-cli-specialists.sh <agents_dir> [project_root]
#
# Always uses ln -sfn (safe for concurrent pi-docker on the same folder).
# Does not delete unknown files in the destination dirs.
set -euo pipefail

agents_dir="${1:-}"
project_root="${2:-.}"

if [ -z "$agents_dir" ] || [ ! -d "$agents_dir" ]; then
  echo "symlink-cli-specialists: agents dir missing or not a directory: ${agents_dir:-<empty>}" >&2
  exit 1
fi

# Absolute target paths so symlinks stay valid if cwd changes later.
agents_dir="$(cd "$agents_dir" && pwd)"
project_root="$(cd "$project_root" && pwd)"

shopt -s nullglob
agent_files=("$agents_dir"/*.md)
if [ ${#agent_files[@]} -eq 0 ]; then
  echo "symlink-cli-specialists: no .md agents in $agents_dir" >&2
  exit 0
fi

for dest_rel in .cursor/agents .claude/agents .gemini/agents; do
  dest_dir="$project_root/$dest_rel"
  mkdir -p "$dest_dir"
  for src in "${agent_files[@]}"; do
    name="$(basename "$src")"
    ln -sfn "$src" "$dest_dir/$name"
  done
done
