#!/usr/bin/env bash
# Symlink or render pi package agents into project CLI discovery dirs (Cursor / Claude / Gemini).
#
# Usage: symlink-cli-specialists.sh <agents_dir> [project_root]
#
# Agents without {{INCLUDE:...}} directives are symlinked via ln -sfn.
# Agents with {{INCLUDE:...}} directives are rendered with partials expanded so CLI backends
# receive the full prompt, frontmatter, and JSON output contract.
# Skips destinations that already exist as a user-authored regular file (no silent overwrite).
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

GENERATED_MARKER="<!-- generated-by: symlink-cli-specialists -->"
render_tmp="$(mktemp -d)"
trap 'rm -rf "$render_tmp"' EXIT

# Pre-render any agent files that use {{INCLUDE:...}} directives once per run.
has_includes=0
for src in "${agent_files[@]}"; do
  if grep -q '{{INCLUDE:' "$src"; then
    has_includes=1
    break
  fi
done

if [ "$has_includes" -eq 1 ]; then
  AGENTS_DIR="$agents_dir" RENDER_TMP="$render_tmp" GENERATED_MARKER="$GENERATED_MARKER" node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const agentsDir = fs.realpathSync(process.env.AGENTS_DIR);
const renderTmp = process.env.RENDER_TMP;
const marker = process.env.GENERATED_MARKER;
const INCLUDE_RE = /\{\{INCLUDE:([^}\r\n]+)\}\}/g;
const MAX_DEPTH = 4;

function expand(text, visited, depth = 0) {
  if (!text.includes("{{INCLUDE:") || depth >= MAX_DEPTH) return text;
  return text.replace(new RegExp(INCLUDE_RE.source, "g"), (fullMatch, rawRel) => {
    const rel = rawRel.trim();
    if (!rel || path.isAbsolute(rel)) return fullMatch;
    const candidate = path.resolve(agentsDir, rel);
    if (candidate !== agentsDir && !candidate.startsWith(agentsDir + path.sep)) return fullMatch;
    let canonical;
    try {
      canonical = fs.realpathSync(candidate);
    } catch {
      return fullMatch;
    }
    if (canonical !== agentsDir && !canonical.startsWith(agentsDir + path.sep)) return fullMatch;
    if (visited.has(canonical)) return fullMatch;
    const content = fs.readFileSync(canonical, "utf-8").trimEnd();
    const nextVisited = new Set(visited);
    nextVisited.add(canonical);
    return expand(content, nextVisited, depth + 1);
  });
}

for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
  if (entry.name.startsWith("_") || !entry.name.endsWith(".md")) continue;
  if (!entry.isFile() && !entry.isSymbolicLink()) continue;
  const srcPath = path.join(agentsDir, entry.name);
  const raw = fs.readFileSync(srcPath, "utf-8");
  if (!raw.includes("{{INCLUDE:")) continue;
  const canonical = fs.realpathSync(srcPath);
  const expanded = expand(raw, new Set([canonical])).trimEnd();
  fs.writeFileSync(path.join(renderTmp, entry.name), `${expanded}\n\n${marker}\n`, "utf-8");
}
NODE
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
    case "$name" in _*) continue ;; esac
    dest="$dest_dir/$name"
    rendered="$render_tmp/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ -L "$dest" ]; then
        :
      elif [ -f "$dest" ] && grep -qF "$GENERATED_MARKER" "$dest"; then
        :
      else
        echo "symlink-cli-specialists: skip non-symlink $dest" >&2
        continue
      fi
    fi

    if [ -f "$rendered" ]; then
      rm -f "$dest"
      tmp_out="$dest_dir/.${name}.tmp.$$"
      cp "$rendered" "$tmp_out"
      mv -f "$tmp_out" "$dest"
    else
      rm -f "$dest"
      ln -sfn "$src" "$dest"
    fi
  done
done
