/**
 * Pure helper functions for dangerous-command enforcement.
 * Extracted to allow testing without SDK dependencies.
 */

import { createLogger } from "../shared/logger.js";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { DANGEROUS, getCurrentBranch, hasGitSub } from "./git-helpers.js";

const enfLog = createLogger("enforcement");
enfLog.debug("enforcement-helpers module loaded");

export type EnforcementResult = { block: true; reason: string } | { autofix: true; modifiedCommand: string; reason: string } | undefined;

/** Whether uv is available on this system (checked at session_start) */
let uvAvailable = true;
export function setUvAvailable(val: boolean): void { uvAvailable = val; }
export function isUvAvailable(): boolean { return uvAvailable; }

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

/**
 * Detect whether a commit command already contains a trailer with the given
 * NAME (e.g. `Assisted-by:`). A commit message must only ever have ONE such
 * trailer, so we match by name — not by the full identity string — to avoid
 * appending a duplicate when the committer (e.g. git-expert) already added one
 * with a DIFFERENT model/identity string (or an unexpanded `$PI_MODEL`).
 *
 * The command embeds the message inside a quoted string where line breaks may
 * appear as REAL newline characters OR as the two-character escaped `\n`
 * sequence (echo -e / printf style). We therefore accept, immediately before
 * the trailer name: start-of-string, a real newline, a literal `\n` two-char
 * sequence, or a quote/whitespace character.
 */
export function commandHasTrailerByName(command: string, trailerName: string): boolean {
  const escName = trailerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (^|\n real newline|\\n literal backslash-n|quote/space) + name + ":" + space
  const trailerNameRe = new RegExp(String.raw`(^|\n|\\n|["'\s])` + escName + String.raw`:\s`);
  const result = trailerNameRe.test(command);
  enfLog.debug("commandHasTrailerByName", trailerName, "match", result);
  return result;
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

/** Auto-fix direct python commands (prepend uv run), block pip commands */
export function checkPythonPipBlock(command: string, cmdLower: string): EnforcementResult {
  // If uv is not available, skip all python/pip enforcement
  if (!uvAvailable) return undefined;

  if (!cmdLower.startsWith("uv ") && !cmdLower.startsWith("uvx ")) {
    // Use matchAll to find separator positions, then extract segments with their offsets
    const separatorRe = /\n|;|&&|\|\||\||&/g;
    const segments: { start: number; end: number; text: string; textLower: string }[] = [];
    let lastEnd = 0;

    for (const m of command.matchAll(separatorRe)) {
      const segText = command.slice(lastEnd, m.index);
      segments.push({
        start: lastEnd,
        end: m.index!,
        text: segText.trim(),
        textLower: segText.trim().toLowerCase(),
      });
      lastEnd = m.index! + m[0].length;
    }
    const lastSegText = command.slice(lastEnd);
    segments.push({
      start: lastEnd,
      end: command.length,
      text: lastSegText.trim(),
      textLower: lastSegText.trim().toLowerCase(),
    });

    const envVarPrefixRe = /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/;

    // Pass 1: if ANY segment is pip/pip3, block the entire command
    for (const seg of segments) {
      if (!seg.textLower) continue;
      const strippedLower = seg.textLower.replace(envVarPrefixRe, "");
      // Extract first token — handle quoted paths: "path/to/python3" or 'path/to/python3'
      const firstTokenMatch = strippedLower.match(/^(["'])(.+?)\1|^(\S+)/);
      const firstToken = firstTokenMatch?.[2] || firstTokenMatch?.[3] || "";
      const baseCmd = firstToken.replace(/^.*[\/\\]/, "");
      if (baseCmd && /^pip3?$/.test(baseCmd)) {
        return {
          block: true,
          reason: "Direct pip/pip3 forbidden. Use: uv add <pkg> / uvx <tool> / uv run --with <pkg> script.py",
        };
      }
    }

    // Pass 2: rewrite ALL python/python3 segments
    let modifiedCommand = command;
    let anyRewrite = false;
    // Process segments in reverse order so offsets remain valid after each splice
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg.textLower) continue;
      const strippedLower = seg.textLower.replace(envVarPrefixRe, "");
      // Extract first token — handle quoted paths: "path/to/python3" or 'path/to/python3'
      const firstTokenMatch = strippedLower.match(/^(["'])(.+?)\1|^(\S+)/);
      const firstToken = firstTokenMatch?.[2] || firstTokenMatch?.[3] || "";
      const baseCmd = firstToken.replace(/^.*[\/\\]/, "");

      if (baseCmd && /^python3?$/.test(baseCmd)) {
        const origText = seg.text;
        const envVarMatch = origText.match(envVarPrefixRe);
        const envPrefix = envVarMatch?.[0] || "";
        const afterEnv = origText.slice(envPrefix.length);
        // Match quoted or unquoted python executable path
        let origExe: string;
        let fixedAfterEnv: string;
        if (afterEnv.match(/^["']/)) {
          // Quoted path: strip quotes and path, keep original exe name
          const qm = afterEnv.match(/^(["'])(.*?)(python3?)\1(.*)/i);
          origExe = qm?.[3] || baseCmd;
          fixedAfterEnv = `uv run ${origExe}` + (qm?.[4] || "");
        } else {
          origExe = afterEnv.match(/^(\S*[\/\\])?(python3?)\b/i)?.[2] || baseCmd;
          fixedAfterEnv = afterEnv.replace(/^(\S*[\/\\])?python3?\b/i, `uv run ${origExe}`);
        }
        const fixedStmt = envPrefix + fixedAfterEnv;

        // Replace by offset
        const rawSegment = modifiedCommand.slice(seg.start, seg.end);
        const trimStart = rawSegment.indexOf(seg.text);
        const absStart = seg.start + (trimStart >= 0 ? trimStart : 0);
        const absEnd = absStart + seg.text.length;
        modifiedCommand = modifiedCommand.slice(0, absStart) + fixedStmt + modifiedCommand.slice(absEnd);
        anyRewrite = true;
      }
    }

    if (anyRewrite) {
      return {
        autofix: true,
        modifiedCommand,
        reason: "Auto-fixed: prepended `uv run` to python command",
      };
    }
  }
  return undefined;
}

/** Block remote script execution (pipe to shell, process substitution, command substitution/eval) */
export function checkRemoteExecBlock(cmdLower: string): EnforcementResult {
  const cmdForExecCheck = cmdLower.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*/m, "");
  const remoteExecReason = "\u26d4 Remote script execution is forbidden. Download the script first, audit it with security-auditor, then run if safe.";
  if (/\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(ba|c|da|[akz]|fi|tc)?sh\b/.test(cmdForExecCheck) ||
      /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(python[23]?|perl|ruby|node|deno|bun)\b/.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "pipe");
    return { block: true, reason: remoteExecReason };
  }
  // Match curl/wget anywhere inside process substitution <(...), not just as first token
  // Allow quoted strings to handle quoted ) characters inside <(...)
  if (/\b(?:(?:ba|c|da|[akz]|fi|tc)?sh|python[23]?|perl|ruby|node|deno|bun)\b.*<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /\bsource\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck) ||
      /(?:^|[\s;&|])\.\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "proc-sub");
    return { block: true, reason: remoteExecReason };
  }
  // Block when curl/wget is inside a command substitution AND an execution primitive
  // (eval, bash -c, sh -c, etc.) CONSUMES that curl output — either inline
  // ($(curl ...)/`curl ...` passed directly to the primitive) or via a variable
  // that was assigned from curl.
  //
  // FALSE-POSITIVE FIX: A SAFE capture `VAR=$(curl ...)` at a statement boundary,
  // followed by an UNRELATED exec primitive that does NOT reference that variable,
  // is not a remote exec. Example (now ALLOWED):
  //   code=$(curl -s -w "%{http_code}" https://x/json); python3 -c "import json"
  // Here $code never flows into python3, so there is no remote code execution.
  //
  // To avoid opening a bypass we:
  //   1. Record the set of variable names assigned from curl/wget captures.
  //   2. Strip SAFE curl assignments before the inline-substitution exec check, so a
  //      captured-but-unused curl output no longer counts as "curl feeding an exec".
  //   3. Separately block when an exec primitive REFERENCES a curl-assigned variable
  //      (e.g. x=$(curl ...); eval "$x") — stripping alone would miss this.
  //
  // Allow quoted strings inside $() to handle quoted ) characters. Matching curl/wget
  // as a word anywhere inside the substitution is intentional — it trades rare false
  // positives for stronger security against obfuscated curl invocations.
  //
  // Safe-assignment shape: VAR=$(...) / VAR=`...` at a statement boundary, terminated
  // by a statement separator / comment / end. CRITICAL: the captured value must NOT
  // itself contain a NESTED command substitution ($( or backtick) — even inside quotes.
  // Otherwise `var=$(bash -c "$(curl ...)")` (a REAL remote exec) would be treated as a
  // simple safe capture and stripped, opening a bypass. Quoted branches therefore
  // forbid `$(` and backtick, and the unquoted branch forbids them too.
  const qDouble = /"(?:(?!\$\()[^"`])*"/.source;
  const qSingle = /'(?:(?!\$\()[^'`])*'/.source;
  const dollarSub = String.raw`\$\((?:` + qDouble + `|` + qSingle + String.raw`|(?!\$\()(?!` + "`" + String.raw`)[^)])*\)`;
  const backtickSub = "`(?:(?!\\$\\()[^`])*`";
  const captureValue = `(?:${dollarSub}|${backtickSub})`;
  const safeAssignmentSrc =
    String.raw`(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?([a-z_]\w*)=(` +
    captureValue + String.raw`)(?=\s*(?:$|[;&|#\n)}]))`;
  // Collect variable names whose SAFE assignment substitution contains curl/wget.
  const curlVars = new Set<string>();
  for (const m of cmdForExecCheck.matchAll(new RegExp(safeAssignmentSrc, "gi"))) {
    if (/\b(curl|wget)\b/.test(m[2])) curlVars.add(m[1]);
  }
  // Strip ALL safe assignments (curl or not) for the inline-substitution exec check,
  // so a curl output safely captured into a variable no longer counts as an inline
  // substitution feeding an exec primitive.
  const strippedForSub = cmdForExecCheck.replace(new RegExp(safeAssignmentSrc, "gi"), " ");
  // Curl still inside a substitution AFTER stripping safe captures = inline/consumed curl.
  const hasCurlSub = /\$\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/.test(strippedForSub) || /`[^`]*\b(curl|wget)\b/.test(strippedForSub);
  // Anchor exec primitives to command position (start-of-string or after statement separator)
  // to avoid matching inside URLs/arguments (e.g., https://host/eval)
  if (hasCurlSub || curlVars.size > 0) {
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
    // Wrappers/prefixes that may precede the interpreter name at a command position:
    // command/builtin/exec shell builtins, and `uv run` (the test harness rewrites
    // `python3` -> `uv run python3`, so `uv run python3 -c "$x"` must also be detected).
    const wrappers = /(?:(?:command|builtin|exec)\s+|uv\s+run\s+)*/.source;
    const execPrefix = cmdPos + redirections + wrappers;
    // Exec-primitive cores (shell/interpreter with a code-carrying flag or stdin/procsub).
    const shellExec = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+-c\b|\s+<<<|\s+<[^<])/.source;
    const interpExec = /(?:python[23]?|perl|ruby|node|deno|bun)(?:\s+-[ce]\b|\s+<\()/.source;
    // (a)/(b) INLINE: curl substitution survives safe-assignment stripping AND an exec
    // primitive appears at command position — the curl output feeds the primitive.
    // Match shells with -c flag, stdin (<<<, <), or process substitution <(...)
    // Match interpreters with -c/-e flag or process substitution <(...)
    if (hasCurlSub && (
        new RegExp(execPrefix + /eval(?:\s|$)/.source).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + shellExec).test(cmdForExecCheck) ||
        new RegExp(execPrefix + pathPrefix + interpExec).test(cmdForExecCheck))) {
      enfLog.debug("remote_exec_block", "inline-sub");
      return { block: true, reason: remoteExecReason };
    }
    // (c) CONSERVATIVE VARIABLE-FLOW (SECURITY HARDENING): the previous logic only
    // tracked the DIRECT curl-assigned variable name and was bypassable via aliasing
    // (`x=$(curl); y=$x; bash -c "$y"`), quoted aliasing (`y="$x"; eval "$y"`), and
    // indirect expansion (`bash -c "${!x}"`). We cannot statically track how curl output
    // flows through arbitrary variable aliases/indirection, so we take the conservative
    // direction: once curl output has been CAPTURED into the shell (curlVars.size > 0),
    // ANY exec primitive whose command/argument region references ANY shell variable
    // (contains a `$` — `$x`, `${x}`, `${!x}`, `"$x"`, ...) is assumed to potentially
    // carry the curl output and is BLOCKED. Only an exec whose argument region contains
    // NO `$` at all (e.g. `python3 -c "import json"`) is allowed to pass this rule.
    if (curlVars.size > 0) {
      // Argument/target region after the primitive, within the same statement (stops at
      // ; & | newline), that contains at least one `$` variable reference.
      const dollarArg = /[^\n;&|]*\$/.source;
      if (new RegExp(execPrefix + /eval\b/.source + dollarArg).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + shellExec + dollarArg).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + interpExec + dollarArg).test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "var-flow");
        return { block: true, reason: remoteExecReason };
      }
      // (d) UNTRACKABLE INPUT: when a curl capture exists, a shell/interpreter that reads
      // its program from stdin / a file / process-substitution / here-string is blocked
      // regardless of variable reference — the curl output could have been redirected to a
      // file that is then executed, which cannot be tracked statically. This is the
      // conservative direction: only the inline `-c`/`-e` form (which needs an explicit
      // `$` reference to consume curl output, handled by (c)) is allowed to pass through.
      const shellStdin = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+<<<|\s+<[^<]|\s+<\()/.source;
      const interpStdin = /(?:python[23]?|perl|ruby|node|deno|bun)\s+<\(/.source;
      if (new RegExp(execPrefix + pathPrefix + shellStdin).test(cmdForExecCheck) ||
          new RegExp(execPrefix + pathPrefix + interpStdin).test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "untrackable");
        return { block: true, reason: remoteExecReason };
      }
    }
  }
  // Block $(curl ...) and `curl ...` UNLESS every occurrence is a safe shell variable assignment.
  // Safe: VAR=$(curl ...), export VAR=$(curl ...) — only when followed by ; && || or end-of-string
  // Unsafe: bare $(curl), --flag=$(curl), VAR=$(curl ...) cmd (prefix assignment runs cmd)
  if (/\$\(\s*\b(curl|wget)\b/.test(cmdForExecCheck) || /`\s*\b(curl|wget)\b/.test(cmdForExecCheck)) {
    // Block env VAR=$(curl ...) cmd — env runs a command with the var, so curl output could influence execution
    // Note: [a-z_] without /i is fine — cmdLower (the parameter) is already lowercased
    if (/\benv\s+.*[a-z_]\w*=(?:\$\(|`).*\b(curl|wget)\b/.test(cmdForExecCheck)) {
      enfLog.debug("remote_exec_block", "env-var-sub");
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
      enfLog.debug("remote_exec_block", "bare-sub");
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

/**
 * Detect a REAL `git <sub>` invocation (sub = "commit" or "push") at a shell command
 * position — NOT a substring inside a heredoc body, string argument, or file path.
 *
 * BUG #3 FIX: `hasGitSub` matches the literal text `git ... commit` ANYWHERE, so
 * writing a file whose CONTENT mentions "git commit" (heredoc body), an echo/string
 * arg like `echo 'run git commit later'`, or a path like `node "/tmp/git commit x.mjs"`
 * wrongly triggered the commit/push guard. This helper narrows detection to genuine
 * invocations by (1) stripping heredoc bodies and (2) requiring `git` at a command
 * boundary (start, or after ; && || | & newline ( { or control-flow keywords).
 *
 * Security note: we DO NOT attempt full shell quote parsing. We block conservatively
 * — any `git <flags> <sub>` at a command boundary in the (heredoc-stripped) command
 * still blocks. This narrows false-positives without opening a bypass: a real
 * `git commit`/`git push` cannot avoid appearing at a command boundary.
 */
export function isRealGitCommitOrPush(command: string): boolean {
  // Strip heredoc bodies so file CONTENT that mentions "git commit" does not count.
  const stripped = stripHeredocBodies(command);
  // Require git at a command position: start-of-string, or after a statement separator
  // / pipe / background / newline / subshell-open / brace-group / control-flow keyword.
  const boundary = /(?:^|[;&|\n(){]|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source;
  // PREFIX BYPASS FIX: real git invocations can be preceded by allowed prefixes that the
  // old boundary-only check missed — `sudo git commit`, `env GIT_DIR=x git commit`,
  // `GIT_DIR=x git commit` (bare VAR=value assignment prefix), `command git commit`,
  // `builtin`/`exec` wrappers. Allow an optional sequence of these before git:
  //   - sudo (with flags), env (with flags)
  //   - one-or-more VAR=value assignments
  //   - command / builtin / exec wrappers
  //
  // SUDO/ENV ARG BYPASS FIX (finding #3): real sudo/env flags TAKE A FOLLOWING
  // ARGUMENT (`sudo -u root git commit`, `sudo -g grp git commit`, `env -u HOME git
  // commit`), and env accepts VAR=value operands (`env FOO=bar git commit`). The old
  // `(?:\s+-\S+)*` only consumed bare flags, so the arg token stopped the prefix early
  // and these BYPASSED the guard. We now consume, after `sudo`/`env`, a sequence of:
  //   - `--long ARG` long option taking an argument (`--user root`)
  //   - `-x ARG`     short option taking an argument (`-u root`, `-g grp`)
  //   - `-\S+`       bare flag (`-n`, `--preserve-env`, combined `-xyz`)
  //   - `VAR=value`  env operand (`FOO=bar`)
  // A `(?!git\b)` guard on the arg-consuming forms prevents swallowing the `git` token
  // itself; alternatives are ordered specific-first and backtracking resolves the rest.
  const sudoEnvArg = /(?:sudo|env)(?:\s+(?:--\S+\s+(?!git\b)\S+|-[a-zA-Z]\s+(?!git\b)\S+|-\S+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)))*\s+/.source;
  const assignArg = /[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.source;
  const wrapArg = /(?:command|builtin|exec)\s+/.source;
  const prefix = `(?:${sudoEnvArg}|${assignArg}|${wrapArg})*`;
  // Allow an optional path prefix on git itself: `/usr/bin/git`, `/bin/git`, etc. The
  // executable must END in `/git` so that a path ARGUMENT to another program (e.g.
  // `node "/tmp/git commit test.mjs"`) is NOT matched — there git is not the invoked
  // command (first token is `node`, "git commit" lives inside a quoted arg).
  const gitExe = /(?:\S*\/)?git\b/.source;
  // Then allow git's own flags (git -c k=v, git -C dir, --no-pager, etc.) before the sub.
  const gitFlags = /(?:\s+(?:-[a-zA-Z]\s+\S+|-\S+))*/.source;
  for (const sub of ["commit", "push"]) {
    if (new RegExp(boundary + prefix + gitExe + gitFlags + `\\s+${sub}\\b`).test(stripped)) {
      enfLog.debug("git_invocation_detected", sub);
      return true;
    }
  }
  return false;
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

/** True for release bump branches: chore/bump-version-<digit>... */
export function isBumpVersionBranch(branch: string | null): boolean {
  return !!branch && /^chore\/bump-version-\d/.test(branch);
}

/** Branch cache per cwd — avoids repeated git calls on hot edit/write path. */
const branchCache = new Map<string, { branch: string | null; at: number }>();
const BRANCH_CACHE_TTL_MS = 5_000;

export function getCachedBranch(cwd: string): string | null {
  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached && now - cached.at < BRANCH_CACHE_TTL_MS) return cached.branch;
  const branch = getCurrentBranch(cwd);
  // Only cache non-bump-version branches — bump branches must always be fresh
  // to avoid stale results after switching away from a release branch.
  if (!isBumpVersionBranch(branch)) {
    branchCache.set(cwd, { branch, at: now });
  } else {
    branchCache.delete(cwd);
  }
  return branch;
}

/** Clear branch cache (tests). */
export function clearBranchCache(): void {
  branchCache.clear();
}

/** Seed branch cache for testing — inject a value with custom timestamp. */
export function seedBranchCacheForTests(cwd: string, branch: string | null, at?: number): void {
  branchCache.set(cwd, { branch, at: at ?? Date.now() });
}
