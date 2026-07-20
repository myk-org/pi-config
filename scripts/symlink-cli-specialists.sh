#!/usr/bin/env bash
# Symlink pi package agents into project CLI discovery dirs (Cursor / Claude / Gemini).
#
# Usage: symlink-cli-specialists.sh <agents_dir> [project_root]
#
# Always uses ln -sfn for existing symlinks (safe for concurrent pi-docker).
# Skips destinations that already exist as a regular file (no silent overwrite).
# Does not delete unknown files in the destination dirs.
# Refuses to write through symlinked .cursor/.claude/.gemini (or agents/) roots
# so repo-controlled symlinks cannot redirect writes outside the project.
set -euo pipefail

agents_dir="${1:-}"
project_root="${2:-.}"

if [ -z "$agents_dir" ] || [ ! -d "$agents_dir" ]; then
  echo "symlink-cli-specialists: agents dir missing or not a directory: ${agents_dir:-<empty>}" >&2
  exit 1
fi

# Physical absolute paths so symlink components cannot redirect writes.
agents_dir="$(cd "$agents_dir" && pwd -P)"
project_root="$(cd "$project_root" && pwd -P)"

shopt -s nullglob
agent_files=("$agents_dir"/*.md)
if [ ${#agent_files[@]} -eq 0 ]; then
  echo "symlink-cli-specialists: no .md agents in $agents_dir" >&2
  exit 0
fi

for dest_rel in .cursor/agents .claude/agents .gemini/agents; do
  top="${dest_rel%%/*}"
  top_path="$project_root/$top"
  if [ -L "$top_path" ]; then
    echo "symlink-cli-specialists: skip $dest_rel (symlinked $top)" >&2
    continue
  fi

  if [ -e "$top_path" ] && [ ! -d "$top_path" ]; then
    echo "symlink-cli-specialists: skip $dest_rel ($top is not a directory)" >&2
    continue
  fi

  dest_dir="$project_root/$dest_rel"
  if [ -L "$dest_dir" ]; then
    echo "symlink-cli-specialists: skip $dest_rel (symlinked agents dir)" >&2
    continue
  fi
  if [ -e "$dest_dir" ] && [ ! -d "$dest_dir" ]; then
    echo "symlink-cli-specialists: skip $dest_rel (agents path is not a directory)" >&2
    continue
  fi

  if ! mkdir -p "$dest_dir"; then
    echo "symlink-cli-specialists: skip $dest_rel (mkdir failed)" >&2
    continue
  fi
  if [ -L "$dest_dir" ] || [ ! -d "$dest_dir" ]; then
    echo "symlink-cli-specialists: skip $dest_rel (dest not a real directory)" >&2
    continue
  fi

  phys_dest="$(cd "$dest_dir" && pwd -P)"
  case "$phys_dest" in
    "$project_root"|"$project_root"/*) ;;
    *)
      echo "symlink-cli-specialists: skip $dest_rel (escapes project root)" >&2
      continue
      ;;
  esac

  for src in "${agent_files[@]}"; do
    name="$(basename "$src")"
    dest="$dest_dir/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ -L "$dest" ]; then
        ln -sfn "$src" "$dest"
      else
        echo "symlink-cli-specialists: skip non-symlink $dest" >&2
      fi
    else
      ln -sfn "$src" "$dest"
    fi
  done
done
