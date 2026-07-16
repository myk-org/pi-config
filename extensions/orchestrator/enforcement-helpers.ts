/**
 * Pure helper functions for dangerous-command enforcement.
 * Extracted to allow testing without SDK dependencies.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { DANGEROUS, hasGitSub } from "./git-helpers.js";

export type EnforcementResult = { block: true; reason: string } | undefined;

/** Normalize command for repeat detection: strip cd prefixes, trim whitespace */
export function normalizeForRepeatCheck(command: string): string {
  return command
    .replace(/^\s*cd\s+\S+\s*&&\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape a string for safe inclusion in double-quoted shell strings */
export function escapeForDoubleQuote(s: string): string {
  return s.replace(/[\\"`$!]/g, "\\$&");
}

/** Escape a string for safe inclusion in single-quoted shell strings */
export function escapeForSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\\''");
}

/** Parse bash command for cd target to resolve the effective working directory (worktree support) */
export function resolveEffectiveCwd(command: string, sessionCwd: string): string {
  // Match the FIRST cd in the command (at start or after &&, ;, ||)
  // First cd sets up the working directory before subsequent commands run.
  // Using LAST cd is unsafe — a trailing cd (e.g., git commit && cd /tmp) would
  // misattribute the cwd to the wrong directory.
  const cdMatch = command.match(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/);
  if (cdMatch) {
    const target = cdMatch[1].replace(/['"]/g, "");
    if (target.startsWith("/")) return target;
    return join(sessionCwd, target);
  }
  // Match: git -C /path/to/dir ...
  const gitCMatch = command.match(/\bgit\s+-C\s+([^\s]+)/);
  if (gitCMatch) {
    const target = gitCMatch[1].replace(/['"]/g, "");
    if (target.startsWith("/")) return target;
    return join(sessionCwd, target);
  }
  return sessionCwd;
}

/** Block direct python/pip commands */
export function checkPythonPipBlock(cmdLower: string): EnforcementResult {
  if (!cmdLower.startsWith("uv ") && !cmdLower.startsWith("uvx ")) {
    // Split on statement separators to get individual commands,
    // then check if the base command (first word) is python/pip.
    // This avoids false positives on python3/pip appearing inside quoted arguments.
    // Split on statement separators including & (background operator)
    const statements = cmdLower.split(/\n|;|&&|\|\||\||&/).map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      // Strip leading env var assignments: VAR=val, VAR="val", VAR='val'
      const stripped = stmt.replace(/^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, "");
      const baseCmd = stripped.split(/\s/)[0]?.replace(/^.*\//, ""); // strip path prefix
      if (baseCmd && /^(?:python3?|pip3?)$/.test(baseCmd)) {
        return {
          block: true,
          reason:
            "Direct python/pip forbidden. Use: uv run python3 / uv run script.py / uvx tool / uv add pkg",
        };
      }
    }
  }
  return undefined;
}

/** Block remote script execution (pipe to shell, process substitution, command substitution/eval) */
export function checkRemoteExecBlock(cmdLower: string): EnforcementResult {
  const cmdForExecCheck = cmdLower.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*/m, "");
  const remoteExecReason = "\u26d4 Remote script execution is forbidden. Download the script first, audit it with security-auditor, then run if safe.";
  if (/\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*(?:\/\S+\/)*(ba|c|da|[akz]|fi|tc)?sh\b/.test(cmdForExecCheck) ||
      /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*(python[23]?|perl|ruby|node|deno|bun)\b/.test(cmdForExecCheck)) {
    return { block: true, reason: remoteExecReason };
  }
  // Match curl/wget anywhere inside process substitution <(...), not just as first token
  if (/\b(?:(?:ba|c|da|[akz]|fi|tc)?sh|python[23]?|perl|ruby|node|deno|bun)\b.*<\([^)]*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /\bsource\s+<\([^)]*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /(?:^|[\s;&|])\.\s+<\([^)]*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    return { block: true, reason: remoteExecReason };
  }
  // Block when curl/wget is inside a command substitution AND an execution primitive
  // (eval, bash -c, sh -c, etc.) appears anywhere — order-independent.
  // Catches: x=$(curl ...); eval "$x", eval "$x"; x=$(curl ...), etc.
  // Only matches curl/wget actually inside $() or backticks, not bare curl before unrelated $().
  // Detect curl/wget anywhere inside a command substitution, not just as first token.
  // Allow quoted strings inside $() to handle quoted ) characters.
  // Note: this is intentionally conservative — it matches curl/wget as a word anywhere inside
  // the substitution, including in strings like $(echo curl). This trades rare false positives
  // for stronger security against obfuscated curl invocations.
  const hasCurlSub = /\$\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck) || /`[^`]*\b(curl|wget)\b/.test(cmdForExecCheck);
  // Anchor exec primitives to command position (start-of-string or after statement separator)
  // to avoid matching inside URLs/arguments (e.g., https://host/eval)
  if (hasCurlSub) {
    // Allow assignment prefixes (VAR=val, VAR="a b"), sudo, and env before exec primitives.
    // Shell allows VAR="a b" bash -c "cmd" — the assignment sets env for the command.
    const assignPrefix = /(?:[a-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/.source;
    // Include (, {, $( as command-start boundaries for subshells/grouping/command substitution.
    // Use quoted-value-capable env prefix to handle env FOO="a b" bash -c ...
    // Include shell control-flow keywords (then, do, else, elif) as command boundaries
    const cmdPos = /(?:^|[;&|\n({]|&&|\|\||\$\(|\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source + assignPrefix + /(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*/.source + assignPrefix;
    // Allow optional path prefix (/bin/, /usr/bin/, etc.) before shell/interpreter names
    // Allow leading redirections (>file, 2>/dev/null, etc.), shell wrappers (command, builtin, exec)
    const redirections = /(?:(?:[0-9]*>[>&]?|<)\s*\S+\s+)*/.source;
    const pathPrefix = /(?:\/\S+\/)*/.source;
    const wrappers = /(?:(?:command|builtin|exec)\s+)*/.source;
    const execPrefix = cmdPos + redirections + wrappers;
    // Match shells with -c flag, stdin (<<<, <), or process substitution <(...)
    // Match interpreters with -c/-e flag or process substitution <(...)
    if (new RegExp(execPrefix + /eval(?:\s|$)/.source).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+-c\b|\s+<<<|\s+<[^<])/.source).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + /(?:python[23]?|perl|ruby|node|deno|bun)(?:\s+-[ce]\b|\s+<\()/.source).test(cmdForExecCheck)) {
      return { block: true, reason: remoteExecReason };
    }
  }
  // Block $(curl ...) and `curl ...` UNLESS every occurrence is a safe shell variable assignment.
  // Safe: VAR=$(curl ...), export VAR=$(curl ...) — only when followed by ; && || or end-of-string
  // Unsafe: bare $(curl), --flag=$(curl), VAR=$(curl ...) cmd (prefix assignment runs cmd)
  if (/\$\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) || /`\s*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    // Block env VAR=$(curl ...) cmd — env runs a command with the var, so curl output could influence execution
    // Note: [a-z_] without /i is fine — cmdLower (the parameter) is already lowercased
    if (/\benv\s+.*[a-z_]\w*=(?:\$\(|`).*\b(curl|wget)\b/.test(cmdForExecCheck)) {
      return { block: true, reason: remoteExecReason };
    }
    // Strip safe assignment patterns at statement boundaries only.
    // Left boundary: start-of-string or after a statement separator (;, &&, ||, |, &, newline).
    // Right boundary: followed by statement separator, newline, # comment, or end-of-string.
    // This prevents stripping argument-position assignments like echo x=$(curl ...)
    // and prefix assignments like VAR=$(curl ...) cmd.
    // Use negative lookahead to reject nested command substitution (both $( and backticks) inside $() content.
    // Also reject backticks inside $() to prevent var=$(bash -c "`curl ...`") bypass.
    // Allow quoted strings ("..." and '...') inside $() to handle quoted ) characters.
    // Left boundary includes (, { for subshell/brace-group starts. Right boundary includes ), } as terminators.
    const safeAssignment = /(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?[a-z_]\w*=(?:\$\((?:"[^"]*"|'[^']*'|(?!\$\()(?!`)[^)])*\)|`(?:(?!\$\()[^`])*`)(?=\s*(?:$|[;&|#\n)}]))/gi;
    const stripped = cmdForExecCheck.replace(safeAssignment, " ");
    if (/\$\(\s*\b(curl|wget)\b/.test(stripped) || /`\s*\b(curl|wget)\b/.test(stripped)) {
      return { block: true, reason: remoteExecReason };
    }
  }
  return undefined;
}

/** Enforce temp files go to .pi/tmp/ — not bare /tmp/ */
export function checkTempFileEnforcement(command: string, cwd: string): EnforcementResult {
  if (/(?:^|[;&|$( \t])mktemp\b/.test(command)) {
    const expectedTmpDir = path.join(cwd, ".pi", "tmp");
    const usesEnvVar = /\$\{?PROJECT_TMP_DIR\}?/.test(command);
    const usesExpectedPath = command.includes(expectedTmpDir);
    const usesRelativePath = /(?:^|[\s"'=])\.pi\/tmp(?:\/|[\s"']|$)/.test(command);
    if (!usesEnvVar && !usesExpectedPath && !usesRelativePath) {
      return {
        block: true,
        reason: `\u26d4 mktemp must use project temp dir. Use: mktemp \${PROJECT_TMP_DIR}/XXXXXX (resolves to ${expectedTmpDir}/)`,
      };
    }
  }
  return undefined;
}

/**
 * Read-only commands that cannot modify the filesystem.
 * Intentionally conservative — commands like `sort`, `diff`, `ls` are excluded
 * to keep the allow-list tight and reduce attack surface.
 */
export const READ_ONLY_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "cat", "head", "tail", "less", "more", "wc",
  "echo", "printf",
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
    // Backtick substitution — skip escaped backticks (\`)
    if (withoutSingleQuoted[i] === "`") {
      let j = i + 1;
      while (j < withoutSingleQuoted.length) {
        if (withoutSingleQuoted[j] === "\\" && j + 1 < withoutSingleQuoted.length) {
          j += 2; // skip escaped character
          continue;
        }
        if (withoutSingleQuoted[j] === "`") break;
        j++;
      }
      if (j < withoutSingleQuoted.length) {
        results.push(withoutSingleQuoted.slice(i + 1, j));
        i = j + 1;
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
 * Check if a dangerous rm command only targets paths within .pi/tmp/ or /tmp/<something>.
 * Returns true if the command should be silently allowed.
 * Note: bare /tmp (without subpath) is NOT allowed — only /tmp/<file-or-folder>.
 */
export function isRmInProjectTmp(stmt: string, cwd: string): boolean {
  // Only applies to direct rm commands, not find/xargs variants
  if (!RM_PATTERN.test(stmt)) return false;

  // Ensure rm is the actual command, not an argument to another command (e.g., xargs rm)
  const firstWord = stmt.trim().split(/\s+/)[0];
  if (firstWord !== "rm" && !firstWord?.endsWith("/rm")) return false;

  // Don't silently allow if the statement also matches other DANGEROUS patterns
  // (e.g., sudo rm -rf .pi/tmp/foo — sudo should still trigger confirmation)
  if (/\bsudo\b/i.test(stmt)) return false;

  // Reject statements containing subshells or process substitutions — these could
  // embed arbitrary commands that bypass the allowlist check
  if (extractSubshells(stmt).length > 0) return false;

  // Parse arguments: split on whitespace, skip flags, handle -- separator
  const tokens = stmt.trim().split(/\s+/);
  const paths: string[] = [];
  let pastSeparator = false;
  let pastRm = false;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!pastRm) {
      if (token === "rm" || token.endsWith("/rm")) pastRm = true;
      continue;
    }
    if (token === "--") {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator && token.startsWith("-")) continue;
    // Skip shell redirections — handle both joined (2>/dev/null) and spaced (2> /dev/null)
    if (/^[0-9]*>{1,2}|^&>|^[0-9]*</.test(token)) {
      // If the token is ONLY the operator (no target attached), skip the next token too
      if (/^(?:[0-9]*>{1,2}|&>|[0-9]*<)$/.test(token)) {
        skipNext = true;
      }
      continue;
    }
    // Strip surrounding quotes — prevents false positives on rm -rf ".pi/tmp/foo"
    paths.push(token.replace(/^["']|["']$/g, ""));
  }

  // Guard against vacuous truth — if no paths extracted, don't silently allow
  if (paths.length === 0) return false;

  // Resolve and substitute PROJECT_TMP_DIR env var
  const projectTmpDir = path.join(cwd, ".pi", "tmp");
  let resolvedCwd: string | null;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = null; // cwd doesn't exist — project tmp checks will all fail
  }

  for (const p of paths) {
    // Substitute ${PROJECT_TMP_DIR} or $PROJECT_TMP_DIR
    const expanded = p.replace(/\$\{?PROJECT_TMP_DIR\}?/g, projectTmpDir);
    let resolved: string;
    try {
      // Use realpathSync to resolve symlinks — prevents symlink traversal attacks
      resolved = realpathSync(path.resolve(cwd, expanded));
    } catch {
      // Path doesn't exist. For /tmp paths, validate the existing parent via realpathSync
      // to catch symlinked parents (e.g., /tmp/evil-link -> / where evil-link exists).
      const lexical = path.resolve(cwd, expanded);
      if (lexical.startsWith("/tmp/") && lexical !== "/tmp" && lexical.length > 5) {
        // Block paths containing traversal sequences — even if they resolve under /tmp/,
        // they may have escaped and re-entered via ..
        if (expanded.includes("..")) {
          return false;
        }
        // Validate that the existing parent resolves under /tmp
        const parentDir = path.dirname(lexical);
        try {
          const resolvedParent = realpathSync(parentDir);
          // Resolve /tmp itself to handle systems where /tmp is a symlink (e.g., /private/tmp on macOS)
          let resolvedTmp: string;
          try { resolvedTmp = realpathSync("/tmp"); } catch { resolvedTmp = "/tmp"; }
          if (!resolvedParent.startsWith(resolvedTmp + "/") && resolvedParent !== resolvedTmp) {
            return false; // Parent symlinks outside /tmp
          }
        } catch {
          // Parent also doesn't exist — safe (entire path is non-existent)
        }
        resolved = lexical;
      } else if (resolvedCwd !== null &&
        (lexical.startsWith(resolvedCwd + path.sep) || lexical === resolvedCwd) &&
        (lexical.includes(`${path.sep}.pi${path.sep}tmp${path.sep}`) ||
         lexical.endsWith(`${path.sep}.pi${path.sep}tmp`))) {
        // Non-existent path within project .pi/tmp/ — validate parent exists under project
        if (expanded.includes("..")) {
          return false;
        }
        const parentDir = path.dirname(lexical);
        try {
          const resolvedParent = realpathSync(parentDir);
          if (!resolvedParent.startsWith(resolvedCwd + path.sep) && resolvedParent !== resolvedCwd) {
            return false; // Parent symlinks outside project
          }
        } catch {
          // Parent also doesn't exist — safe (entire path is non-existent)
        }
        resolved = lexical;
      } else {
        return false;
      }
    }

    // Check if path is in an allowed temp location:
    // A) Project .pi/tmp/ — path within project AND goes through .pi/tmp/
    // B) System /tmp/<something> — path under /tmp/ but NOT /tmp itself
    const inProjectTmp = resolvedCwd !== null &&
      (resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd) &&
      (resolved.includes(`${path.sep}.pi${path.sep}tmp${path.sep}`) ||
       resolved.endsWith(`${path.sep}.pi${path.sep}tmp`));
    const inSystemTmp = resolved.startsWith("/tmp/") && resolved !== "/tmp" && resolved.length > 5;

    if (!inProjectTmp && !inSystemTmp) return false;
  }

  return true;
}

/** Detect git add --force / -f (including combined short options like -fn).
 *  Respects -- end-of-options marker and shell separators (&&, ;, |, ||). */
export function hasGitAddForce(command: string): boolean {
  if (!hasGitSub(command, "add")) return false;
  // Split on shell separators to isolate individual statements
  const statements = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  for (const stmt of statements) {
    const addMatch = stmt.match(/\bgit\b.*\badd\b\s+(.*)/);
    if (!addMatch) continue;
    const tokens = addMatch[1].split(/\s+/);
    for (const token of tokens) {
      if (token === "--") break; // Everything after -- is a pathspec
      if (token === "--force") return true;
      // Short option: -f or combined like -fn, -vf (starts with - but not --)
      if (token.startsWith("-") && !token.startsWith("--") && token.includes("f")) return true;
    }
  }
  return false;
}

/** Check if a git add command uses bulk-stage tokens (., -A, --all) before the -- separator. */
export function hasGitAddBulk(command: string): boolean {
  if (!hasGitSub(command, "add")) return false;
  const addMatch = command.match(/\bgit\b.*\badd\b\s+(.*)/);
  if (!addMatch) return false;
  const args = addMatch[1];
  // Split tokens, only check before -- (end-of-options marker)
  const tokens = args.split(/\s+/);
  for (const token of tokens) {
    if (token === "--") break; // Everything after -- is a pathspec
    if (token === "." || token === "-A" || token === "--all") return true;
  }
  return false;
}

/** Strip heredoc bodies from command string, preserving commands after the closing delimiter */
export function stripHeredocBodies(cmd: string): string {
  // Match heredoc: <<DELIM ... DELIM and <<-DELIM ... (tab-indented) DELIM
  // For <<- (dash form), the closing delimiter can be preceded by tabs only.
  // Closing delimiter must be on its own line with no trailing content (except newline).
  return cmd.replace(/<<-(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[ \t]*\2\s*(?=\n|$)/gm, "")
    .replace(/<<(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\2\s*(?=\n|$)/gm, "");
}

/**
 * Detect common test runner commands — require command-start position
 * (after &&, |, ;, or line start) to avoid false positives from install/grep/cat commands.
 * NOTE: For compound commands (e.g., pytest && other_cmd), if the non-test part fails,
 * isError=true marks tests as failed even though pytest passed. This is the conservative/safe
 * direction — re-run the test command standalone to mark tests_passed.
 * NOTE: `tox` without `-e` args matches (runs default envs = tests). `tox -e lint` does NOT
 * match — we exclude tox with explicit -e to avoid marking lint/docs runs as test passes.
 */
export function isTestRunnerCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?(?:pytest|vitest|jest|mocha)\b/.test(command)
    || /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?tox\b(?!\s*-e)(?!\s+--(?:help|version|list))/.test(command)
    || /(?:^|[;&|]\s*)go\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npm\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npx\s+tsx\s+--test\b/.test(command);
}
