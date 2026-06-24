/**
 * Pure helper functions for dangerous-command enforcement.
 * Extracted to allow testing without SDK dependencies.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { DANGEROUS } from "./git-helpers.js";

/**
 * Read-only commands that cannot modify the filesystem.
 * Intentionally conservative — commands like `sort`, `diff`, `ls` are excluded
 * to keep the allow-list tight and reduce attack surface.
 */
export const READ_ONLY_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "cat", "head", "tail", "less", "more",
  "echo", "printf", "wc",
]);

/**
 * Extract command substitutions ($(...), `...`) and process substitutions
 * (<(...), >(...)) from a statement, respecting single quotes (which
 * suppress expansion in bash). Returns the extracted command strings.
 */
export function extractSubshells(stmt: string): string[] {
  const results: string[] = [];

  // Strip single-quoted regions — POSIX sh has no escape inside single quotes, so [^']* is correct
  const withoutSingleQuoted = stmt.replace(/'[^']*'/g, "''");

  // Extract $(...) — handle nested parens by counting depth
  let i = 0;
  while (i < withoutSingleQuoted.length) {
    // $( or <( or >(
    if (i < withoutSingleQuoted.length - 1 &&
        ((withoutSingleQuoted[i] === "$" && withoutSingleQuoted[i + 1] === "(") ||
         (withoutSingleQuoted[i] === "<" && withoutSingleQuoted[i + 1] === "(") ||
         (withoutSingleQuoted[i] === ">" && withoutSingleQuoted[i + 1] === "("))) {
      const start = i + 2;
      let depth = 1;
      let j = start;
      while (j < withoutSingleQuoted.length && depth > 0) {
        if (withoutSingleQuoted[j] === "(") depth++;
        else if (withoutSingleQuoted[j] === ")") depth--;
        j++;
      }
      if (depth === 0) {
        results.push(withoutSingleQuoted.slice(start, j - 1));
      }
      i = j;
      continue;
    }
    // Backtick substitution
    if (withoutSingleQuoted[i] === "`") {
      const end = withoutSingleQuoted.indexOf("`", i + 1);
      if (end !== -1) {
        results.push(withoutSingleQuoted.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return results;
}

/**
 * Check if a statement is a read-only command with no dangerous subshells.
 * Returns true if the DANGEROUS check should be skipped for this statement.
 */
export function isReadOnlyStatement(stmt: string): boolean {
  // Extract the base command (first word, strip any leading env vars like VAR=val)
  const stripped = stmt.replace(/^\s*(?:\S+=\S*\s+)*/, "");
  const baseCmd = stripped.split(/\s/)[0]?.replace(/^.*\//, ""); // strip path prefix
  if (!baseCmd || !READ_ONLY_COMMANDS.has(baseCmd)) return false;

  // Check subshells for dangerous content
  const subshells = extractSubshells(stmt);
  // Evaluate extracted content against DANGEROUS as raw strings — catches nested subshells too
  return !subshells.some((sub) => DANGEROUS.some((p) => p.test(sub)));
}

/** Pattern matching direct recursive rm commands (subset of DANGEROUS patterns). */
const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i;

/**
 * Check if a dangerous rm command only targets paths within .pi/tmp/.
 * Returns true if the command should be silently allowed.
 */
export function isRmInProjectTmp(stmt: string, cwd: string): boolean {
  // Only applies to direct rm commands, not find/xargs variants
  if (!RM_PATTERN.test(stmt)) return false;

  // Don't silently allow if the statement also matches other DANGEROUS patterns
  // (e.g., sudo rm -rf .pi/tmp/foo — sudo should still trigger confirmation)
  if (/\bsudo\b/i.test(stmt)) return false;

  // Parse arguments: split on whitespace, skip flags, handle -- separator
  const tokens = stmt.trim().split(/\s+/);
  const paths: string[] = [];
  let pastSeparator = false;
  let pastRm = false;

  for (const token of tokens) {
    if (!pastRm) {
      if (token === "rm" || token.endsWith("/rm")) pastRm = true;
      continue;
    }
    if (token === "--") {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator && token.startsWith("-")) continue;
    // Strip surrounding quotes — prevents false positives on rm -rf ".pi/tmp/foo"
    paths.push(token.replace(/^["']|["']$/g, ""));
  }

  // Guard against vacuous truth — if no paths extracted, don't silently allow
  if (paths.length === 0) return false;

  // Resolve and substitute PROJECT_TMP_DIR env var
  const projectTmpDir = path.join(cwd, ".pi", "tmp");
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    return false;
  }

  for (const p of paths) {
    // Substitute ${PROJECT_TMP_DIR} or $PROJECT_TMP_DIR
    const expanded = p.replace(/\$\{?PROJECT_TMP_DIR\}?/g, projectTmpDir);
    let resolved: string;
    try {
      // Use realpathSync to resolve symlinks — prevents symlink traversal attacks
      resolved = realpathSync(path.resolve(cwd, expanded));
    } catch {
      // Path doesn't exist — non-existent paths can't be symlink escapes,
      // but also can't be verified as safe. Fall through to normal prompt.
      return false;
    }

    // Both conditions required:
    // 1. Path is within the project (starts with cwd)
    // 2. Path goes through .pi/tmp/ (our designated temp directory)
    if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) return false;
    if (!resolved.includes(`${path.sep}.pi${path.sep}tmp${path.sep}`) &&
        !resolved.endsWith(`${path.sep}.pi${path.sep}tmp`)) return false;
  }

  return true;
}
