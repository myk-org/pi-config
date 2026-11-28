/**
 * Deep bash enforcement policy module — single coherent boundary owning:
 * - Unified shell lexing, quoting, heredoc, and substitution scanning
 * - Dangerous-pattern registry (DANGEROUS_RULES) and noexec syntax-check exemption
 * - Git command classification, conflict-resolution detection, and identity/settings guards
 * - Command-policy evaluation (evaluateBashPolicy, evaluateFileWritePolicy)
 */

import { createLogger } from "../shared/logger.js";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { basename, dirname, join, resolve } from "node:path";
import { escapeRegExp, getProjectDataDir, realpathNearestExisting, sanitizeModelId } from "./utils.js";
import {
  getGlobalSettingsPath,
  getSetting,
  getSettingsPath,
  LEGACY_SETTINGS_FILENAME,
  loadGlobalSettings,
  loadProjectSettings,
  readSettingsFile,
  SETTINGS_FILENAMES,
  withSettingsFileLock,
  writeSettingsFile,
} from "./project-settings.js";
import {
  getCurrentBranch,
  getMainBranch,
  getPrMergeStatus,
  getProtectedBranches,
  isBranchAhead,
  isBranchMerged,
  isGitRepo,
  isInsideGitWorkTree,
  listUnmergedFiles,
  runGit,
} from "./git-helpers.js";

const enfLog = createLogger("enforcement");
enfLog.debug("bash-policy module loaded");

// ── Shell Lexing, Heredoc Scanning & Git Command Classification ─────────────

/**
 * Split a shell segment into words, honouring quotes and backslash escapes, so
 * `conflicted\ repo` is one word and `-c core.editor="vim -f"` is one option.
 */
export function decodeAnsiCEscapes(inner: string): string {
  return inner.replace(
    /\\(?:U([0-9a-fA-F]{1,8})|u([0-9a-fA-F]{1,4})|x([0-9a-fA-F]{1,2})|([0-7]{1,3})|c(.)|([abeEfnrtv?'"\\]))/g,
    (m, uni8?: string, uni4?: string, hex?: string, oct?: string, ctrl?: string, esc?: string) => {
      if (uni8 !== undefined) {
        const code = Number.parseInt(uni8, 16);
        return code >= 1 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      if (uni4 !== undefined) {
        const code = Number.parseInt(uni4, 16);
        return code >= 1 && code <= 0xffff ? String.fromCodePoint(code) : m;
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code >= 1 && code <= 0xff ? String.fromCharCode(code) : m;
      }
      if (oct !== undefined) {
        const code = Number.parseInt(oct, 8) & 0xff;
        return code >= 1 ? String.fromCharCode(code) : m;
      }
      if (ctrl !== undefined) {
        return String.fromCharCode(ctrl.toUpperCase().charCodeAt(0) ^ 0x40);
      }
      switch (esc) {
        case "a": return "\x07";
        case "b": return "\b";
        case "e":
        case "E": return "\x1b";
        case "f": return "\f";
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        case "v": return "\v";
        case "?": return "?";
        case "'": return "'";
        case "\"": return "\"";
        case "\\": return "\\";
        default: return m;
      }
    },
  );
}

/**
 * Decode Bash ANSI-C `$'...'` literals (including `\U`, `\u`, `\x`, octal, `\cX`,
 * and standard single-letter escapes) into equivalent single-quoted strings BEFORE
 * `tokenize()` discards quote delimiters.
 */
export function preprocessAnsiCQuotes(script: string): string {
  if (!script.includes("$'")) return script;
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "\\" && !inSingle && i + 1 < script.length) {
      out += ch + script[i + 1]!;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === "$" && script[i + 1] === "'") {
      let j = i + 2;
      let body = "";
      while (j < script.length) {
        const c = script[j]!;
        if (c === "\\" && j + 1 < script.length) {
          body += c + script[j + 1]!;
          j += 2;
          continue;
        }
        if (c === "'") break;
        body += c;
        j++;
      }
      if (j < script.length && script[j] === "'") {
        const decoded = decodeAnsiCEscapes(body);
        out += `'${decoded.replace(/'/g, "'\\''")}'`;
        i = j;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function tokenize(text: string): string[] {
  enfLog.debug("tokenize", "chars", text.length);
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { current += text[i + 1]; i++; continue; }
    if (/\s/.test(ch)) {
      if (has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

/**
 * The shell part of a command: what it would actually run.
 *
 * Quoted text is not automatically inert — `bash -c 'git add x'`,
 * `eval '...'` and `"$(git add x)"` all execute — and a heredoc body is inert
 * except for substitutions, while the text *after* the delimiter on the opener
 * line still runs. So this scans rather than pattern-matches: literals are kept,
 * `$(...)`, backticks and script arguments are descended into, heredoc bodies
 * contribute only their substitutions, and an inert quoted span collapses to a
 * placeholder token so `git -C "repo" add` stays parseable.
 */
type ScanMode = "full" | "words" | "body" | "literal-body";

/**
 * Emitted when nesting exceeded the scan depth: the scanner stopped early and
 * did not see everything. Callers must treat it as "not safe to allow" rather
 * than as absence of a command.
 */
const UNSCANNED = "\u0000unscanned-nesting\u0000";

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Return character count of a `\\\n` or `\\\r\n` line continuation at `i`, or 0. */
function skipLineContinuation(s: string, i: number): number {
  if (s[i] !== "\\") return 0;
  if (s[i + 1] === "\n") return 2;
  if (s[i + 1] === "\r" && s[i + 2] === "\n") return 3;
  return 0;
}

/** Return index of the `\n` ending a `#` line comment starting at `hashIdx` (or `s.length`). */
function skipLineComment(s: string, hashIdx: number): number {
  const nl = s.indexOf("\n", hashIdx);
  return nl === -1 ? s.length : nl;
}

/** Given the index of `'` in `$'...'`, return the closing `'` index honoring `\` escapes, or null. */
function scanAnsiCQuoteEnd(s: string, openQuoteIdx: number): number | null {
  let i = openQuoteIdx + 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (ch === "'") return i;
    i++;
  }
  return null;
}

/** Given the index of `` ` ``, return the closing `` ` `` index honoring `\` escapes, or null. */
function scanBacktickEnd(s: string, openIdx: number): number | null {
  let i = openIdx + 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (ch === "`") return i;
    i++;
  }
  return null;
}

/** If `s` at `i` starts a closed inline heredoc (`<<[-]\s*['"]?[\w-]+['"]?`), return the last index
 *  of its terminator line (so a `for (;; i++)` loop resumes at the following `\n` or EOF), else null. */
function skipInlineHeredoc(s: string, i: number): number | null {
  if (s[i] !== "<" || s[i + 1] !== "<" || s[i + 2] === "<") return null;
  const opener = matchHeredocOpener(s.slice(i), "comments");
  if (!opener || !/^[\w-]+$/.test(opener.delim)) return null;
  const nl = s.indexOf("\n", i + opener.length);
  if (nl === -1) return null;
  const { next, closed } = skipHeredocBody(
    s,
    nl + 1,
    [{ delim: opener.delim, stripTabs: opener.stripTabs }],
    { stripCr: true },
  );
  if (!closed) return null;
  return next > 0 && s[next - 1] === "\n" ? next - 2 : next - 1;
}

interface BalancedParenScanOptions {
  end?: number;
  honorComments?: boolean;
  honorHeredocs?: boolean;
  honorAnsiC?: boolean;
  honorBacktick?: boolean;
  recurseDoubleQuote?: boolean;
  singleQuoteEscapes?: boolean;
  unquotedEscapes?: boolean;
  onCloseParen?: (idx: number) => void;
}

/** Shared quote-aware scanner for balanced parentheses starting at `openParenIdx` (`(`).
 *  Returns the matching `)` index, or `null` if unterminated before `end`. */
function scanBalancedParen(
  s: string,
  openParenIdx: number,
  opts: BalancedParenScanOptions = {},
): number | null {
  const limit = opts.end ?? s.length;
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = openParenIdx + 1; i < limit; i++) {
    const ch = s[i]!;
    if (quote !== null) {
      if ((quote === '"' || opts.singleQuoteEscapes) && ch === "\\" && i + 1 < limit) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (opts.honorComments && ch === "#" && (i === openParenIdx + 1 || /[\s(;&|]/.test(s[i - 1]!))) {
      i = Math.min(limit, skipLineComment(s, i));
      continue;
    }
    if (opts.honorHeredocs && ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      const end = skipInlineHeredoc(s, i);
      if (end !== null && end < limit) {
        i = end;
        continue;
      }
    }
    if (opts.unquotedEscapes && ch === "\\" && i + 1 < limit) {
      i++;
      continue;
    }
    if (opts.honorAnsiC && ch === "'" && i > 0 && s[i - 1] === "$") {
      const close = scanAnsiCQuoteEnd(s, i);
      if (close === null || close >= limit) return null;
      i = close;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (opts.recurseDoubleQuote) {
        const close = scanDoubleQuoteEnd(s, i, { honorHeredocs: opts.honorHeredocs, honorBacktick: false });
        if (close === null || close >= limit) return null;
        i = close;
        continue;
      }
      quote = ch;
      continue;
    }
    if (opts.honorBacktick && ch === "`") {
      const close = scanBacktickEnd(s, i);
      if (close === null || close >= limit) return null;
      i = close;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      opts.onCloseParen?.(i);
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

interface DoubleQuoteScanOptions {
  honorHeredocs?: boolean;
  honorBacktick?: boolean;
  lenientSubstParen?: boolean;
}

/** Shared closing-quote scanner for single and double quotes starting at `openIdx`.
 *  Returns the closing quote index, or `null` if unterminated. */
function scanDoubleQuoteEnd(
  s: string,
  openIdx: number,
  opts: DoubleQuoteScanOptions = {},
): number | null {
  const q = s[openIdx];
  if (q !== '"' && q !== "'") return null;
  if (q === "'") {
    const close = s.indexOf("'", openIdx + 1);
    return close < 0 ? null : close;
  }
  for (let i = openIdx + 1; i < s.length; i++) {
    if (opts.honorHeredocs && s[i] === "<" && s[i + 1] === "<") {
      const end = skipInlineHeredoc(s, i);
      if (end !== null) {
        enfLog.debug("matchingQuoteIndex skip heredoc");
        i = end;
        continue;
      }
    }
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "(") {
      const closeParen = opts.lenientSubstParen
        ? matchingParen(s, i + 1)
        : matchingSubstParenIndex(s, i + 1);
      if (closeParen === null) return null;
      i = closeParen;
      continue;
    }
    if (opts.honorBacktick && s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return null;
}

/** Shared quote state machine backing `stripSingleQuotedRegions` and `maskQuotedRegions`:
 *  - `"strip-single"`: collapses `'...'` to `''` while keeping `"..."` verbatim (double-quote aware).
 *  - `"mask-all"`: replaces the interior of both `'...'` and `"..."` with a single space.
 *  Both respect unquoted `\` escapes and re-emit unterminated quotes raw so a stray quote
 *  cannot hide trailing executable text from security guards. */
function scanQuotedRegions(input: string, mode: "strip-single" | "mask-all"): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  let openIndex = -1;
  while (i < input.length) {
    const ch = input[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === "\\" && i + 1 < input.length) {
        if (mode === "strip-single") out += input.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (mode === "strip-single") {
          out += quote === "'" ? "''" : '"';
        } else {
          out += " ";
          out += quote;
        }
        quote = null;
        i++;
        continue;
      }
      if (mode === "strip-single" && quote === '"') out += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      out += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      openIndex = i;
      if (mode === "mask-all" || ch === '"') out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (quote !== null && openIndex >= 0) {
    if (mode === "strip-single") {
      if (quote === "'") out += input.slice(openIndex);
    } else {
      out += input.slice(openIndex + 1);
    }
  }
  return out;
}

/** Closing paren of a `$(`, ignoring parens inside quotes. */
function matchingParen(cmd: string, open: number): number {
  const close = scanBalancedParen(cmd, open, { singleQuoteEscapes: true });
  if (close !== null) {
    enfLog.debug("matching_paren", "at", close);
    return close;
  }
  enfLog.debug("matching_paren_unterminated", "open", open);
  return cmd.length;
}

/** Index of the closing quote, skipping over $( ) and backtick regions. */
function closingQuote(cmd: string, open: number, quote: string): number {
  const close = quote === "'"
    ? (() => {
        const idx = cmd.indexOf("'", open + 1);
        return idx === -1 ? null : idx;
      })()
    : scanDoubleQuoteEnd(cmd, open, { honorBacktick: true, lenientSubstParen: true });
  if (close !== null) {
    enfLog.debug("closing_quote", "quote", quote, "at", close);
    return close;
  }
  enfLog.debug("closing_quote_unterminated", "quote", quote, "open", open);
  return cmd.length;
}

/**
 * True when the quoted span at `at` is a script argument — the string a shell
 * runs. Covers `bash -c`, bundled short flags (`bash -xc`), options before `-c`
 * (`bash --login -c`), ANSI-C quoting (`bash -c $'…'`), and `eval`.
 */
function isScriptArgument(cmd: string, at: number): boolean {
  const before = cmd.slice(0, at).replace(/[$]+$/, "").trimEnd();
  const words = before.split(/\s+/);
  // Walk back over option words to the command word that started them.
  let i = words.length - 1;
  let sawCommandOption = false;
  while (i >= 0 && words[i].startsWith("-") && words[i].length > 1) {
    if (words[i] === "-" || words[i].startsWith("--")) {
      // A long option may take the script as its value.
      if (/^--(command|login|noprofile|norc|interactive|posix|verbose|xtrace|echo|errexit|nounset|pipefail)$/.test(words[i])) sawCommandOption = true;
    } else if (words[i].includes("c")) {
      sawCommandOption = true;
    }
    i--;
  }
  // Compare the executable's name, so /bin/bash and /usr/bin/env-less paths
  // resolve the same as a bare `bash`.
  const command = (words[i] ?? "").split("/").pop() ?? "";
  if (command === "eval" || command === "source" || command === ".") return true;
  if (!SHELL_NAMES.has(command)) return false;
  // A bare `bash 'script'` is a script file, not a script string.
  enfLog.debug("script_argument", "command", command, "option", sawCommandOption);
  return sawCommandOption;
}

/** Does `line` terminate the heredoc? Ordinary delimiters match exactly; `<<-` allows leading tabs. */
function isHeredocTerminator(line: string, delim: string, stripTabs: boolean): boolean {
  const isTerminator = stripTabs && line.charCodeAt(0) === 9 ? line.replace(/^\t+/, "") === delim : line === delim;
  enfLog.debug("heredoc_terminator", "delim", delim, "strip_tabs", stripTabs, "matched", isTerminator);
  return isTerminator;
}

export interface HeredocSpec {
  delim: string;
  expand?: boolean;
  stripTabs: boolean;
}

export type HeredocGrammar = "executable" | "comments" | "piped-commit";

const HEREDOC_OPENER_RES: Record<HeredocGrammar, RegExp> = {
  executable: /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|)'\n]+))/,
  comments: /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s;&|)'"\\`\n])+))/,
  "piped-commit": /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>'"`]+))/,
};

export function matchHeredocOpener(
  slice: string,
  grammar: HeredocGrammar = "executable",
): { delim: string; expand: boolean; stripTabs: boolean; length: number } | null {
  const m = HEREDOC_OPENER_RES[grammar].exec(slice);
  if (!m) return null;
  const rawUnquoted = m[4];
  const delim =
    m[2] !== undefined
      ? m[2]
      : m[3] !== undefined
        ? m[3]
        : grammar === "comments"
          ? rawUnquoted!.replace(/\\(.)/g, "$1")
          : rawUnquoted!;
  return {
    delim,
    expand: m[2] === undefined && m[3] === undefined,
    stripTabs: m[1] === "-",
    length: m[0].length,
  };
}

export function skipHeredocBody(
  cmd: string,
  start: number,
  pending: ReadonlyArray<HeredocSpec>,
  opts?: { stripCr?: boolean; onBodyLine?: (line: string, index: number) => void },
): { next: number; closed: boolean } {
  let cursor = start;
  let allClosed = true;
  for (let hIdx = 0; hIdx < pending.length; hIdx++) {
    const h = pending[hIdx]!;
    let closed = false;
    while (cursor <= cmd.length) {
      let lineEnd = cmd.indexOf("\n", cursor);
      const atEnd = lineEnd === -1;
      if (atEnd) lineEnd = cmd.length;
      const rawLine = cmd.slice(cursor, lineEnd);
      const line = opts?.stripCr ? rawLine.replace(/\r$/, "") : rawLine;
      if (isHeredocTerminator(line, h.delim, h.stripTabs)) {
        cursor = atEnd ? cmd.length : lineEnd + 1;
        closed = true;
        break;
      }
      opts?.onBodyLine?.(rawLine, hIdx);
      cursor = atEnd ? cmd.length : lineEnd + 1;
      if (atEnd) break;
    }
    if (!closed) {
      allClosed = false;
      break;
    }
  }
  return { next: cursor, closed: allClosed };
}

export function executableText(cmd: string, depth = 0, mode: ScanMode = "full"): string {
  if (depth > 6) return UNSCANNED;
  const keepLiterals = mode === "full" || mode === "words";
  const keepSubstitutions = mode !== "literal-body";
  let out = "";
  const pendingHeredocs: { delim: string; expand: boolean; stripTabs: boolean }[] = [];
  const add = (s: string) => { out += s; };
  let substitutions = 0;
  let heredocs = 0;
  let continuations = 0;
  let comments = 0;
  let hereStrings = 0;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    // A backslash escapes whatever follows: `conflicted\ repo` is one word with
    // a space, and a backslash before a newline is a continuation the shell
    // removes entirely. Leaving either in place breaks word splitting - which is
    // how `git -C conflicted\ repo add` hid its subcommand from the matcher.
    if (ch === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] === "\n") {
        continuations++;
        i++;
        continue;
      }
      // The escape is kept: `conflicted\ repo` is one word, and the tokenizer
      // downstream is what knows that. Stripping it here would turn it into two.
      if (keepLiterals) {
        add(ch);
        add(cmd[i + 1]);
      }
      i++;
      continue;
    }

    // A `#` at the start of a word begins a comment: nothing after it runs, so a
    // heredoc-looking token inside one must not swallow the lines below.
    if (ch === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      let end = cmd.indexOf("\n", i);
      if (end === -1) end = cmd.length;
      comments++;
      // The newline that ends a comment is a command boundary like any other:
      // dropping it would join the next command onto the previous segment's text
      // and read `note; git add x` as one segment starting with `note`.
      if (end < cmd.length) add("\n");
      i = end;
      continue;
    }

    // A here-string (`<<<word`) is one data argument, not a heredoc. Its text
    // is inert, but a substitution inside it still runs, so scan it for those.
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] === "<") {
      let j = i + 3;
      while (j < cmd.length && /[ \t]/.test(cmd[j])) j++;
      const quote = cmd[j];
      let end = j;
      if (quote === "'" || quote === '"') {
        end = closingQuote(cmd, j, quote);
        add(` ${executableText(cmd.slice(j + 1, end), depth + 1, quote === '"' ? "body" : "literal-body")} `);
        hereStrings++;
      } else {
        while (end < cmd.length && !/[\s;&|]/.test(cmd[end])) end++;
        add(` ${executableText(cmd.slice(j, end), depth + 1, "body")} `);
        hereStrings++;
      }
      i = end;
      continue;
    }

    // Heredoc opener: remember the delimiter, keep scanning the same line.
    if (ch === "<" && cmd[i + 1] === "<") {
      const m = matchHeredocOpener(cmd.slice(i), "executable");
      if (m) {
        pendingHeredocs.push({
          delim: m.delim,
          expand: m.expand,
          stripTabs: m.stripTabs,
        });
        heredocs++;
        i += m.length - 1;
        continue;
      }
    }

    // Heredoc bodies start after this line. One cursor walks past each body and
    // its terminator, so a second heredoc on the same line resumes in the right
    // place instead of inside the first body.
    if (ch === "\n" && pendingHeredocs.length > 0) {
      const bodies: string[][] = pendingHeredocs.map(() => []);
      const { next } = skipHeredocBody(cmd, i + 1, pendingHeredocs, {
        onBodyLine: (line, hIdx) => bodies[hIdx]!.push(line),
      });
      for (let hIdx = 0; hIdx < pendingHeredocs.length; hIdx++) {
        const h = pendingHeredocs[hIdx]!;
        if (h.expand && keepSubstitutions) add(` ${executableText(bodies[hIdx]!.join("\n"), depth + 1, "body")} `);
      }
      pendingHeredocs.length = 0;
      // A newline, so whatever follows the terminator starts its own command.
      add("\n");
      i = next - 1;
      continue;
    }

    // Command substitution — always executes.
    if (ch === "$" && cmd[i + 1] === "(" && keepSubstitutions) {
      const end = matchingParen(cmd, i + 1);
      substitutions++;
      // Parenthesised so the substituted commands are command positions of their
      // own rather than trailing arguments of the command that expanded them.
      add(`(${executableText(cmd.slice(i + 2, end), depth + 1)})`);
      i = end;
      continue;
    }
    if (ch === "`" && keepSubstitutions) {
      const end = cmd.indexOf("`", i + 1);
      substitutions++;
      add(`(${executableText(cmd.slice(i + 1, end === -1 ? cmd.length : end), depth + 1)})`);
      i = end === -1 ? cmd.length : end;
      continue;
    }

    // Inside a double-quoted span or a heredoc body an apostrophe is an ordinary
    // character - "it's" is not a quote. Treating it as one swallowed the
    // substitutions that follow, e.g. printf %s "it's $(git add a.txt)".
    if (ch === "'" && !keepLiterals) {
      if (keepSubstitutions) {
        const end = cmd.indexOf("'", i + 1);
        add(` ${executableText(cmd.slice(i + 1, end === -1 ? cmd.length : end), depth + 1, "body")} `);
        i = end === -1 ? cmd.length : end;
      }
      continue;
    }

    // ANSI-C quoting: $'…' — literal, but still a script argument to `sh -c`.
    const ansi = ch === "$" && cmd[i + 1] === "'";
    if (ansi || ch === "'") {
      const start = ansi ? i + 1 : i;
      // No closing quote: bash reports an unexpected EOF and runs nothing at all,
      // so the rest of the command is not executable. Treating the tail as run
      // would be the unsafe direction — it would invent a staging command the
      // shell never performs.
      const end = cmd.indexOf("'", start + 1);
      const content = cmd.slice(start + 1, end === -1 ? cmd.length : end);
      // A quoted part glued to adjacent text is part of the same shell word
      // (`g'add'` is `gadd`, `git''` is `git`), so it must be concatenated. Only
      // a standalone quoted argument collapses to a placeholder.
      // `$'…'` is its own word — the `$` is a token, not glued text. An
      // unterminated quote is not glued either: bash reports an unexpected EOF
      // and runs nothing, so the tail must not be read as a command.
      const glued = !ansi && end !== -1 && start > 0 && !/[\s;&|(]/.test(cmd[start - 1]);
      if (isScriptArgument(cmd, start)) {
        // Newlines, not spaces: the script is a command of its own, so a cd or
        // git inside it starts a segment rather than trailing an option word.
        if (keepSubstitutions) add(`\n(${executableText(decodeAnsiC(content), depth + 1)})\n`);
        else add(" _ ");
      } else if (glued || /(?:\bgit|\bcd|\bpushd|\bchdir|-C)$/.test(out.trimEnd())) {
        // The subcommand or a directory argument, quoted: `git 'add' x`,
        // `cd 'work tree'`, `git -C 'my repo' add`. A directory is re-quoted so a
        // name with a space stays one word for the directory walker.
        const isDirArg = /(?:\bcd|\bpushd|\bchdir|-C)$/.test(out.trimEnd());
        add(isDirArg ? `"${content}"` : content);
      } else {
        add(" _ ");
      }
      i = end === -1 ? cmd.length : end;
      continue;
    }
    if (ch === '"') {
      const end = closingQuote(cmd, i, '"');
      const content = cmd.slice(i + 1, end);
      const glued = i > 0 && !/[\s;&|(]/.test(cmd[i - 1]);
      if (isScriptArgument(cmd, i)) {
        if (keepSubstitutions) add(`\n(${executableText(content, depth + 1)})\n`);
      } else if (glued || /(?:\bgit|\bcd|\bpushd|\bchdir|-C)$/.test(out.trimEnd())) {
        // Part of a shell word, or a quoted directory argument: keep the text so
        // the word survives concatenation. Quoting is re-emitted so a path with
        // spaces still reaches the directory walker as one argument.
        const isDirArg = /(?:\bcd|\bpushd|\bchdir|-C)$/.test(out.trimEnd());
        add(isDirArg ? `"${content}"` : executableText(content, depth + 1, "full"));
      } else if (keepSubstitutions) {
        // Only the substitutions inside a double-quoted span execute.
        substitutions++;
        add(`(${executableText(content, depth + 1, "body")})`);
      } else {
        add(" _ ");
      }
      i = end;
      continue;
    }

    if (keepLiterals) add(ch);
  }
  enfLog.debug("shell_scan", "depth", depth, "mode", mode, "heredocs", heredocs, "substitutions", substitutions, "continuations", continuations, "comments", comments, "here_strings", hereStrings);
  return out;
}

/**
 * Git commands that write a *resolution* of an in-progress merge/rebase/
 * cherry-pick. Inspecting a conflicted tree (`git status`, `git diff`) and
 * backing out (`--abort`) are deliberately not in this set.
 */


/** Shell keywords and `VAR=value` prefixes that precede a segment's command. */
const SEGMENT_SKIP = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "(", ")", "function", "coproc"]);

/**
 * Words after which a `git` token is still executed rather than merely printed:
 * these run the command that follows them, so `xargs git add` and
 * `find . -exec git add` stage while `echo git add` does not.
 */
const GIT_EXECUTORS = new Set([
  "xargs", "find", "-exec", "-execdir", "env", "sudo", "time", "nohup", "nice",
  "ionice", "stdbuf", "setsid", "command", "exec", "timeout",
  // These run their argument as commands. A shell is deliberately absent: its
  // script argument is emitted as a segment of its own, and treating `bash` as a
  // wrapper instead made `bash -c 'echo git add'` look like a staging command.
  "eval", "source", ".",
]);

/** Wrapper options whose operand names something other than the command. */
export const WRAPPER_VALUE_OPTIONS = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role",
  "-t", "--type", "-U", "--other-user", "-C", "--chdir", "--preserve-env",
]);

/** Options that change directory, which differ per wrapper. */
const WRAPPER_CHDIR_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-D", "--chdir"]),
  env: new Set(["-C", "--chdir"]),
};
/** Git's own directory option. */
/**
 * Git's own options that name the repository. -C moves the working directory and
 * --git-dir names the repository outright.
 *
 * Deliberately not --work-tree: the git directory is what selects the index that
 * records a merge, so two work trees over one git directory share one conflict
 * state and must not be treated as separate repositories.
 */
const GIT_CHDIR_OPTIONS = new Set(["-C", "--git-dir"]);

/** For a wrapper with no directory option of its own. */
const NO_CHDIR_OPTIONS = new Set<string>();

/** Is this word the git executable? A full or relative path names it just as well. */
function isGitWord(word: string): boolean {
  return word === "git" || word.endsWith("/git");
}

/**
 * Does this segment run git? A segment whose *command word* is git, or one that
 * follows a wrapper which executes the rest. Matching the text alone is wrong:
 * `cd ~/git/proj` contains the word without running anything.
 */
export function segmentRunsGit(segment: string): boolean {
  const verdict = classifySegment(segment);
  enfLog.debug("segment_runs_git", "verdict", verdict);
  return verdict;
}

/**
 * The index of the word that runs the segment's command: skips control keywords,
 * inline assignments, and TRANSPARENT prefixes whose own options sit before the
 * command they run (`rtk -v git add`). Every consumer that needs "what does this
 * segment actually run" goes through here, so a prefix is never handled in one
 * parser and forgotten in another (Qodo, PR #996).
 */
export function skipToCommandWord(words: string[]): number {
  let k = 0;
  while (k < words.length) {
    // `function NAME { ... }` puts the name between the keyword and the body.
    if (words[k] === "function") { k += 2; continue; }
    if (SEGMENT_SKIP.has(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { k += 1; continue; }
    // rtk runs exactly the command after it, so the next word decides. It is not
    // an executor: `rtk grep git add f` runs grep, it does not stage.
    if (words[k] === "rtk") {
      k += 1;
      while (k < words.length && words[k].startsWith("-") && words[k] !== "-") {
        k += WRAPPER_VALUE_OPTIONS.has(words[k]) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  return k;
}

function classifySegment(segment: string): boolean {
  const words = tokenize(segment.trim());
  const k = skipToCommandWord(words);
  if (k < words.length) {
    // A segment can start mid-subshell, so `(git` is still the git command.
    const head = words[k].replace(/^[()]+|[()]+$/g, "");
    if (isGitWord(head)) return true;
    if (executorRunsGit(words, k, head)) return true;
  }
  // A parenthesised group is real syntax, so a git command inside one runs even
  // when the segment starts with something else: `printf %s ((git add x))`.
  if (/[()]/.test(segment)) {
    for (const inner of segment.split(/[()]+/)) {
      if (inner.trim() && segmentRunsGit(inner)) return true;
    }
  }
  return false;
}

/**
 * The word lists of every git invocation that actually runs: a git token that is
 * a segment's command word, or one that follows a word which executes what comes
 * after it. An argument that merely names git - `echo git add a.txt` - is not a
 * command. Words are kept as tokens and never rejoined: an option value may hold
 * an escaped space, and joining would split it back into two words.
 */
function executedGitCommands(cmd: string): string[][] {
  const kept: string[][] = [];
  for (const raw of cmd.split(/[\n;&|()]+/)) {
    const words = tokenize(raw.trim());
    const k = skipToCommandWord(words);
    if (k >= words.length) continue;
    // A segment can start mid-subshell, so `(git` is still the git command.
    const head = words[k].replace(/^[()]+|[()]+$/g, "");
    if (isGitWord(head)) {
      kept.push(words.slice(k));
    } else if (executorRunsGit(words, k, head)) {
      // The wrapper runs the rest, so any git token in the segment counts.
      for (let i = k + 1; i < words.length; i++) {
        if (isGitWord(words[i])) kept.push(words.slice(i));
      }
    }
  }
  enfLog.debug("executed_git_commands", "count", kept.length);
  return kept;
}

/**
 * Does a wrapper at `k` run git? `command -v git` prints the path instead of
 * running anything, so a lookup is not an invocation.
 */
function executorRunsGit(words: string[], k: number, head: string): boolean {
  if (!GIT_EXECUTORS.has(head)) return false;
  if (head === "command" && /^-[vV]$/.test(words[k + 1] ?? "")) return false;
  return words.slice(k + 1).some(isGitWord);
}

/** Global options whose value is the next word rather than an attached one. */
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c"]);
const GLOBAL_LONG_VALUE_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * The index of the subcommand in a git word list.
 *
 * Only a few global options take their value as a separate word. Assuming every
 * option does swallowed the subcommand itself — `git --no-pager add x` read
 * `add` as the value of `--no-pager` and then found no subcommand at all.
 */
/** The index of the word that runs git, or -1. */
function gitWordIndex(words: string[]): number {
  const k = skipToCommandWord(words);
  if (k < words.length) {
    const head = words[k].replace(/^[()]+|[()]+$/g, "");
    if (isGitWord(head)) return k;
    // A wrapper runs whatever follows it. `command -v git` prints the path
    // instead of running anything, and `sudo -u git` names a user, not a
    // command - so a wrapper's own options are stepped over, operands included.
    if (GIT_EXECUTORS.has(head) && !/^-[vV]$/.test(words[k + 1] ?? "")) {
      // The operand of a wrapper option names something else: `sudo -u git`
      // runs git as a user called git, and never runs it at all.
      // Walk past the wrapper's own options. One that takes a value takes the
      // next word too, and that word is its operand: in `sudo -u git merge` the
      // git is the user to run as, and the command is merge.
      let i = k + 1;
      let from = i;
      while (i < words.length) {
        const tok = words[i];
        if (!tok.startsWith("-") || tok === "-") break;
        i += WRAPPER_VALUE_OPTIONS.has(tok) ? 2 : 1;
        from = i;
      }
      for (let j = from; j < words.length; j++) if (isGitWord(words[j])) return j;
    }
    return -1;
  }
  return -1;
}

/** The index of the subcommand, given where the git word starts. */
function gitSubcommandIndex(words: string[], gitAt = 0): number {
  let k = gitAt + 1;
  while (k < words.length && words[k].startsWith("-") && words[k] !== "-") {
    const tok = words[k];
    const attached = tok.length > 2 && !tok.startsWith("--") ? true : tok.includes("=");
    const takesNext = tok.startsWith("--") ? GLOBAL_LONG_VALUE_OPTIONS.has(tok) : GLOBAL_VALUE_OPTIONS.has(tok);
    if (!attached && takesNext && words[k + 1] && !words[k + 1].startsWith("-")) k += 2;
    else k += 1;
  }
  return k;
}

/** The directory a git word list targets, via its global -C values, in order. */
/**
 * The directory a chdir option names, in whichever of its spellings it is
 * written: separated (`-C dir`, `--chdir dir`), attached (`-Cdir`) or with an
 * equals sign (`--chdir=dir`).
 */
function chdirValue(tok: string, options: Set<string>, next?: string): string | undefined {
  for (const opt of options) {
    if (tok === opt) return next;
    // Only a long option separates its value with `=`. On a short one the
    // equals sign is part of the name, so `-C=repo` names the directory
    // `=repo` and not `repo`.
    if (opt.startsWith("--") && tok.startsWith(`${opt}=`)) return tok.slice(opt.length + 1);
    if (!opt.startsWith("--") && tok.startsWith(opt) && tok.length > opt.length) return tok.slice(opt.length);
  }
  return undefined;
}

/**
 * The directories a git invocation is moved into by directory options, in order.
 *
 * Two regions contribute. Before the git word sits a chain of wrappers, each of
 * which may change directory with its own option — and they disagree: sudo
 * changes directory with -D and uses -C for a descriptor limit, while env -C and
 * git -C both change directory. Which wrapper owns which option therefore has to
 * be tracked as the words are read, rather than assumed from the first one.
 */
function gitScopeValues(words: string[], gitAt = 0): string[] {
  const values: string[] = [];
  let wrapper = "";
  for (let i = 0; i < gitAt; i++) {
    const tok = words[i];
    if (!tok.startsWith("-") || tok === "-") {
      wrapper = tok.replace(/^[()]+|[()]+$/g, "");
      continue;
    }
    const opt = tok.split("=")[0];
    const value = chdirValue(tok, WRAPPER_CHDIR_OPTIONS[wrapper] ?? NO_CHDIR_OPTIONS, words[i + 1]);
    if (value !== undefined) {
      values.push(value);
      if (!tok.includes("=") && tok === opt) i++;
      continue;
    }
    // Any other option may take a value of its own; step over it so a wrapper
    // name is not mistaken for the command.
    if (!tok.includes("=") && WRAPPER_VALUE_OPTIONS.has(opt) && words[i + 1]) i++;
  }
  // Git's own global options, up to the subcommand.
  for (let i = gitAt + 1; i < words.length; i++) {
    const tok = words[i];
    if (!tok.startsWith("-") || tok === "-") break;
    const value = chdirValue(tok, GIT_CHDIR_OPTIONS, words[i + 1]);
    if (value !== undefined) {
      values.push(value);
      if (!tok.includes("=") && !tok.startsWith("--")) i++;
      continue;
    }
    if (!tok.includes("=") && GLOBAL_LONG_VALUE_OPTIONS.has(tok) && words[i + 1]) i++;
  }
  enfLog.debug("git_scope_values", "count", values.length, "last", values[values.length - 1] ?? "cwd");
  return values;
}

/** ANSI-C quoting turns these escapes into characters the shell really sees. */
function decodeAnsiC(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, " ");
}

/**
 * Does this command both *create* a conflict and stage a side of it?
 *
 * The index is read once, before the command runs, so `git merge branch &&
 * git add conflicted.txt` sees a clean tree and then does in one line what the
 * handoff exists to prevent. Reading only the sequencer and only the staging is
 * enough: neither alone says anything, and together they are the whole bypass.
 */
export function createsAndResolvesConflict(command: string): boolean {
  const scanned = executableText(command);
  if (scanned.includes(UNSCANNED)) return true;
  // Subcommands that merge, and therefore can leave conflicts behind.
  const STARTERS = new Set(["merge", "rebase", "cherry-pick", "revert", "am", "pull"]);
  // Flags that make a sequencer do the opposite: a backout resolves nothing and
  // finishing an existing conflict is the handoff's job, not a way around it.
  const BACKOUT = /--(?:abort|quit|continue|skip)\b/;
  // `git stash list` reads; `stash pop` and `stash apply` merge and can conflict.
  const STASH_STARTS = new Set(["pop", "apply", "branch"]);
  const SIDE_PICKING = new Set(["update-index", "restore", "rm", "reset"]);

  // Repositories in which a sequencer has already started, keyed by the directory
  // each one actually resolves to. A later merge in a different repository must
  // not be attributed to the first one, and staging is only a resolution in a
  // repository that started it.
  const started = new Set<string>();
  for (const raw of scanned.split(/[\n;&|()]+/)) {
    const words = tokenize(raw.trim());
    const k = gitWordIndex(words);
    if (k === -1) continue;
    // Which repository this invocation targets: git applies each -C in turn.
    let scope = "";
    for (const c of gitScopeValues(words, k)) scope = resolve(scope || ".", c);
    const k0 = gitSubcommandIndex(words, k);
    const sub = (words[k0] ?? "").split("=")[0];
    const rest = words.slice(k0 + 1).join(" ");
    const starts =
      (STARTERS.has(sub) && !BACKOUT.test(rest)) ||
      (sub === "stash" && STASH_STARTS.has((words[k0 + 1] ?? "").split("=")[0]));
    if (starts) started.add(scope);
    // Staging counts only after the sequencer, and only in the same repository:
    // `git -C a merge && git -C b add x` touches two unrelated trees.
    const stages = sub === "add" || SIDE_PICKING.has(sub) || (sub === "checkout" && /(^|\s)--/.test(rest));
    if (stages && started.has(scope)) {
      enfLog.debug("conflict_created_and_resolved", "scope", scope || "cwd", "subcommand", sub);
      return true;
    }
  }
  enfLog.debug("conflict_created_and_resolved", "started", started.size, "resolved", false);
  return false;
}

export function isConflictResolutionCommand(command: string): boolean {
  const scanned = executableText(command);
  // Nesting deeper than the scan depth means the scanner stopped early. Treat
  // that as a resolution command rather than as proof there is none — checked on
  // the scan itself, before filtering, or the marker would be filtered away.
  if (scanned.includes(UNSCANNED)) {
    enfLog.warn("conflict_command_unscanned", "depth_limit", 6);
    return true;
  }
  // Every one of these clears an unmerged entry, which is picking a side:
  //   git add / git rm / git restore   stage the working tree as-is
  //   git reset                       drop the index entry
  //   git checkout <side flags>       take one side, by flag or by revision
  //   <sequencer> --continue/--skip   advance past the conflicted commit
  // `--abort` is deliberately absent: it backs out rather than resolving.
  //
  // Subcommands come from the token stream, not from a `git ... add` pattern: an
  // option value may contain a space, so `git -C conflicted\ repo add` is `add`
  // with a two-word value, which no regex over the raw line can see past.
  const STAGE_SUBCOMMANDS = new Set(["add", "rm", "restore", "reset", "update-index"]);
  const SEQUENCERS = new Set(["merge", "rebase", "cherry-pick", "revert", "am"]);
  let matches = false;
  for (const words of executedGitCommands(scanned)) {
    const k = gitSubcommandIndex(words);
    const sub = words[k] || "";
    const rest = words.slice(k + 1).join(" ");
    // A subcommand the scanner could not read could be any of them.
    if (sub === "_" || sub.includes("$")) {
      enfLog.warn("conflict_command_dynamic_subcommand", "matches", true);
      matches = true;
      break;
    }
    if (
      STAGE_SUBCOMMANDS.has(sub) ||
      // A side flag, `-m` to re-merge, or `-- <path>` after a revision — each
      // takes one side of the conflict.
      (sub === "checkout" && /(^|\s)(?:--(?:ours|theirs|mine)\b|-m\b|--(?:\s|$))/.test(rest)) ||
      (SEQUENCERS.has(sub) && /--(?:continue|skip|quit)\b/.test(rest))
    ) {
      matches = true;
      break;
    }
  }
  enfLog.debug("conflict_command_classified", "matches", matches);
  return matches;
}

// ── Noexec Syntax-Check Exemption ──────────────────────────────────────────

const NOEXEC_WRAPPERS_RE =
  /^(?:(?:[0-9]*>{1,2}|&>)\S*\s+)*(?:\s*(?:[A-Za-z_]\w*=\S*|(?:then|do|else|elif)\b|sudo(?:\s+-\S+(?:\s+\S+)?)*|rtk(?:\s+-\S+)*|(?:command|builtin|exec)\b|env(?:\s+(?:-\S+(?:\s+\S+)?|\S+=\S*))*|timeout\s+(?:-\S+(?:\s+\S+)?\s+)*\S+|nice(?:\s+(?:-\S+(?:\s+\S+)?))*|nohup\b)\s+)*/i;
const NOEXEC_SHELL_RE = /^(?:\S*\/)?(?:ba|da|z|k|c|tc|fi)?sh\b/i;
const NOEXEC_DISALLOWED_CHARS_RE = /[$`'"\\]|<(?=\()|>(?=\()/;
const NOEXEC_C_FLAG_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const NOEXEC_N_FLAG_RE = /^-[a-zA-Z]*n/;

/** `bash -n file`, `sh -n script`, `bash -x -n f` — the shell only PARSES: nothing is executed.
 *  A syntax check is not a command to approve, so the gate must not treat it as running a shell.
 *  Only an exact `-n` token counts; anything fuzzier stays dangerous. */
export function isNoexecSyntaxCheck(statement: string): boolean {
  // The calling shell expands and word-splits before the syntax check runs: `$(...)` executes,
  // `${IFS}` splits one token into several options (`bash -n${IFS}+n${IFS}-c …`), backticks run,
  // and `<(...)`/`>(...)` execute. ANY `$` is refused outright — a legitimate `bash -n script.sh`
  // never needs one. Quotes and backslashes go too: the CALLING shell removes them before Bash
  // parses, so `bash -n '+n' script.sh` would hand Bash a `+n` option while this predicate saw a
  // harmless operand.
  if (NOEXEC_DISALLOWED_CHARS_RE.test(statement)) return false;
  const rest = statement.replace(NOEXEC_WRAPPERS_RE, "").trim();
  const shellMatch = NOEXEC_SHELL_RE.exec(rest);
  if (!shellMatch) return false;
  const tokens = rest.slice(shellMatch[0].length).trim().split(/\s+/).filter(Boolean);

  // `-n` only counts in the shell's OWN leading option block, and only if nothing turns it back
  // off. The invocation accepts the `set` options, so `+n` re-enables execution:
  //   `bash script.sh -n`  — operand, the script runs
  //   `bash -- -n`         — `--` ends the options; it runs a FILE called `-n`
  //   `bash -n +n script`  — noexec is switched off again
  let noexec = false;
  for (const token of tokens) {
    if (token === "--") break; // option terminator: everything after is an operand
    // `+` options enable modes again (`+n`, `+o noexec`, …). Refusing ALL of them keeps this
    // predicate from having to model the whole `set` option table.
    if (token.startsWith("+")) return false;
    if (!token.startsWith("-")) break; // first operand (script name or argument)
    // `-c` takes the program text — whatever follows is executed as parsed, so never exempt it.
    if (NOEXEC_C_FLAG_RE.test(token)) return false;
    if (NOEXEC_N_FLAG_RE.test(token)) noexec = true; // -n, -xn, -nx
  }
  return noexec;
}

// ── Unified Dangerous-Pattern Registry ─────────────────────────────────────

/**
 * Per-pattern explanation shown on the dangerous-command prompt (issue
 * #1073): `why` names the rule that fired, `consequence` says what can be
 * lost or exposed, and `grants` says what approving this statement permits.
 */
export interface DangerousExplanation {
  why: string;
  consequence: string;
  grants: string;
}

/** Single source of truth pairing each dangerous regex with its label and prompt explanation. */
export interface DangerousRule {
  readonly pattern: RegExp;
  readonly label: string;
  readonly explanation: DangerousExplanation;
}

export const DANGEROUS_RULES: readonly DangerousRule[] = [
  {
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
    label: "recursive delete (rm -r)",
    explanation: {
      why: "recursive delete — removes a directory tree",
      consequence: "every file under it is gone; there is no recovery path",
      grants: "this exact command — another target still prompts",
    },
  },
  {
    pattern: /\bsudo\b/i,
    label: "sudo",
    explanation: {
      why: "sudo — runs the command as another user",
      consequence: "it can change any file, service or user that user can reach, and the audit log names that user, not you",
      grants: "this exact command — any other command behind sudo still prompts",
    },
  },
  {
    pattern: /\b(chmod|chown)\b.*777/i,
    label: "chmod/chown 777",
    explanation: {
      why: "chmod/chown with a 777 argument",
      consequence: "the target ends up world-writable or owned by someone else, so other local users can change it",
      grants: "this exact command — other permission changes still prompt",
    },
  },
  {
    pattern: /\bmkfs\b/i,
    label: "mkfs",
    explanation: {
      why: "mkfs — formats a filesystem",
      consequence: "every file on that device is destroyed; there is no recovery path",
      grants: "this exact command — the device or filesystem is not remembered",
    },
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//i,
    label: "dd to a device",
    explanation: {
      why: "dd writing to a raw device",
      consequence: "a mistyped of= erases a disk, a partition table or a boot sector",
      grants: "this exact command — the target device is not remembered",
    },
  },
  {
    pattern: /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i,
    label: "git reset --hard",
    explanation: {
      why: "git reset --hard — discards working-tree changes",
      consequence: "uncommitted edits are lost; git cannot restore them",
      grants: "this exact command — other resets still prompt",
    },
  },
  {
    pattern: /\bgit\b[\s\S]*\bclean\b[\s\S]*(?:--force|-\S*f)/i,
    label: "git clean --force",
    explanation: {
      why: "git clean --force — deletes untracked files; -n/--dry-run deletes nothing",
      consequence: "work that was never committed is removed; git cannot restore it",
      grants: "this exact command — other cleans still prompt",
    },
  },
  {
    pattern: /\bfind\b[\s\S]*\s-delete\b/i,
    label: "find -delete",
    explanation: {
      why: "find -delete — deletes every match",
      consequence: "the matched set is usually larger than it looks; deleted files have no recovery path",
      grants: "this exact command — a different search still prompts",
    },
  },
  {
    pattern: /\bfind\b[\s\S]*-exec(?:dir)?\s+(?:\/\S+\/)?rm\b/i,
    label: "find -exec rm",
    explanation: {
      why: "find -exec rm — runs rm on every match",
      consequence: "the matched set is usually larger than it looks; deleted files have no recovery path",
      grants: "this exact command — a different search still prompts",
    },
  },
  {
    pattern: /\bxargs\s+(?:-\S+\s+)*(?:\/\S+\/)?rm\b/i,
    label: "xargs rm",
    explanation: {
      why: "xargs rm — deletes whatever is piped in",
      consequence: "the input can be any file your user can see; deleted files have no recovery path",
      grants: "this exact command — another pipeline still prompts",
    },
  },
  {
    // Bare shell invocation (issue #947, hardened PR #948 R1+R2): the shell
    // name must be in COMMAND POSITION — the first word of the statement
    // (statements are split on `;`/`&&`/`||`/`|`/`&`, so a pipe target is its
    // own statement), optionally behind LEADING REDIRECTIONS (`2>/dev/null sh`)
    // and wrapper prefixes (sudo/env/timeout/nice/nohup/xargs/command/builtin/
    // exec/rtk, VAR=value assignments, and control keywords left at the head of
    // a split statement — `then sh`, `do zsh`, `else ksh`). Wrappers consume
    // their option VALUES (`sudo -u root`, `env -u HOME`, `nice -n 10`,
    // `timeout -s KILL 5` — the duration is consumed too) — a flag with a
    // separate value argument must not shield the shell that follows it.
    pattern: /^(?:(?:[0-9]*>{1,2}|&>)\S*\s+)*(?:\s*(?:[A-Za-z_]\w*=\S*|(?:then|do|else|elif)\b|sudo(?:\s+-\S+(?:\s+\S+)?)*|rtk(?:\s+-\S+)*|(?:command|builtin|exec)\b|env(?:\s+(?:-\S+(?:\s+\S+)?|\S+=\S*))*|timeout\s+(?:-\S+(?:\s+\S+)?\s+)*\S+|nice(?:\s+(?:-\S+(?:\s+\S+)?))*|nohup\b|xargs(?:\s+-\S+)*)\s+)*(?:\S*\/)?(?:ba|da|z|k|c|tc|fi)?sh(?:\s|$)/i,
    label: "bare shell invocation",
    explanation: {
      why: "shell invocation — a shell runs a script whose effects the command line does not bound",
      consequence: "an arbitrary, unreviewed script runs with your full user rights",
      grants: "this exact command — a different script still prompts",
    },
  },
];

const DANGEROUS_RULE_BY_PATTERN = new Map<RegExp, DangerousRule>(
  DANGEROUS_RULES.map((rule) => [rule.pattern, rule]),
);

/** Derived views from DANGEROUS_RULES — index alignment is guaranteed by construction. */
export const DANGEROUS: RegExp[] = DANGEROUS_RULES.map((r) => r.pattern);
export const DANGEROUS_LABELS: string[] = DANGEROUS_RULES.map((r) => r.label);
export const DANGEROUS_EXPLANATIONS: DangerousExplanation[] = DANGEROUS_RULES.map((r) => r.explanation);

/** Label for a DANGEROUS pattern object (O(1) lookup against DANGEROUS_RULES). */
export function dangerousPatternLabel(pattern: RegExp): string {
  return DANGEROUS_RULE_BY_PATTERN.get(pattern)?.label ?? String(pattern);
}

/** Explanation for a DANGEROUS pattern object (O(1) lookup against DANGEROUS_RULES). */
export function dangerousPatternExplanation(pattern: RegExp): DangerousExplanation {
  return (
    DANGEROUS_RULE_BY_PATTERN.get(pattern)?.explanation ?? {
      why: `matched ${String(pattern)}`,
      consequence: "the matched command runs unchecked",
      grants: "this exact command",
    }
  );
}

/** Every distinct explanation for the rules a statement trips — a chain (or
 *  one statement) judged as a whole must not show only the first rule
 *  (#1073 review: `sudo rm -rf /srv/data` hides one of the two risks). */
export function dangerousPatternExplanations(patterns: RegExp[]): DangerousExplanation[] {
  const seen = new Set<string>();
  const out: DangerousExplanation[] = [];
  for (const pattern of patterns) {
    const ex = dangerousPatternExplanation(pattern);
    if (seen.has(ex.why)) continue;
    seen.add(ex.why);
    out.push(ex);
  }
  return out;
}

// ── Policy Helpers, Scanners, Allowlists & Rewriters ───────────────────────


export type EnforcementResult = { block: true; reason: string } | { autofix: true; modifiedCommand: string; reason: string } | undefined;

/** Whether uv is available on this system (checked at session_start) */
let uvAvailable = true;
export function setUvAvailable(val: boolean): void { uvAvailable = val; }
export function isUvAvailable(): boolean { return uvAvailable; }

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
  const escName = escapeRegExp(trailerName);
  // (^|\n real newline|\\n literal backslash-n|quote/space) + name + ":" + space
  const trailerNameRe = new RegExp(String.raw`(^|\n|\\n|["'\s])` + escName + String.raw`:\s`);
  const result = trailerNameRe.test(command);
  enfLog.debug("commandHasTrailerByName", trailerName, "match", result);
  return result;
}

/** Consume heredoc bodies (preserving body + terminator verbatim) after the opener line's `\n`. */
function consumeShellHeredocBodies(
  cmd: string,
  start: number,
  pending: ReadonlyArray<HeredocSpec>,
): { text: string; next: number } {
  const { next, closed } = skipHeredocBody(cmd, start, pending, { stripCr: true });
  if (!closed) enfLog.debug("consumeShellHeredocBodies unclosed heredoc", pending[0]?.delim);
  return { text: cmd.slice(start, next), next };
}

function scanBacktickShellComments(cmd: string, start: number): { text: string; next: number } {
  let out = "";
  let i = start;
  let atWordStart = true;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (ch === "`") {
      out += "`";
      return { text: out, next: i + 1 };
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      out += cmd.slice(i, i + 2);
      atWordStart = cmd[i + 1] === "\n" ? atWordStart : false;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) enfLog.debug("scanBacktickShellComments unclosed single quote");
      const end = close === -1 ? cmd.length : close + 1;
      out += cmd.slice(i, end);
      i = end;
      atWordStart = false;
      continue;
    }
    if (ch === '"') {
      out += '"';
      i++;
      let closed = false;
      while (i < cmd.length) {
        const qch = cmd[i]!;
        if (qch === "\\" && i + 1 < cmd.length) {
          out += cmd.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += qch;
        i++;
        if (qch === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) enfLog.debug("scanBacktickShellComments unclosed double quote");
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      enfLog.debug("scanBacktickShellComments stripped comment");
      while (i < cmd.length && cmd[i] !== "\n" && cmd[i] !== "`") i++;
      continue;
    }
    out += ch;
    atWordStart = /[\s;&|()]/.test(ch);
    i++;
  }
  enfLog.debug("scanBacktickShellComments unclosed backtick");
  return { text: out, next: i };
}

function scanUnquotedShellComments(
  cmd: string,
  start: number,
  stopAtCloseParen: boolean,
): { text: string; next: number } {
  let out = "";
  let i = start;
  let atWordStart = true;
  let parenDepth = stopAtCloseParen ? 1 : 0;
  const pendingHeredocs: Array<{ delim: string; stripTabs: boolean }> = [];

  while (i < cmd.length) {
    const ch = cmd[i]!;

    const cont = skipLineContinuation(cmd, i);
    if (cont > 0) {
      enfLog.debug("scanUnquotedShellComments line continuation", cont === 2 ? "lf" : "crlf");
      out += cmd.slice(i, i + cont);
      i += cont;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      out += cmd.slice(i, i + 2);
      i += 2;
      atWordStart = false;
      continue;
    }

    if (ch === "#" && atWordStart) {
      i = skipLineComment(cmd, i);
      continue;
    }

    if (ch === "$" && cmd[i + 1] === "'") {
      const close = scanAnsiCQuoteEnd(cmd, i + 1);
      if (close === null) enfLog.debug("scanUnquotedShellComments unclosed ansi-c quote");
      const end = close === null ? cmd.length : close + 1;
      out += cmd.slice(i, end);
      i = end;
      atWordStart = false;
      continue;
    }

    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) enfLog.debug("scanUnquotedShellComments unclosed single quote");
      const end = close === -1 ? cmd.length : close + 1;
      out += cmd.slice(i, end);
      i = end;
      atWordStart = false;
      continue;
    }

    if (ch === '"') {
      out += '"';
      i++;
      let closed = false;
      while (i < cmd.length) {
        const dch = cmd[i]!;
        if (dch === "\\" && i + 1 < cmd.length) {
          out += cmd.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (dch === "$" && cmd[i + 1] === "(") {
          out += "$(";
          const sub = scanUnquotedShellComments(cmd, i + 2, true);
          out += sub.text;
          i = sub.next;
          continue;
        }
        if (dch === "`") {
          out += "`";
          const bt = scanBacktickShellComments(cmd, i + 1);
          out += bt.text;
          i = bt.next;
          continue;
        }
        out += dch;
        i++;
        if (dch === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) enfLog.debug("scanUnquotedShellComments unclosed double quote");
      atWordStart = false;
      continue;
    }

    if (ch === "$" && cmd[i + 1] === "(") {
      out += "$(";
      const sub = scanUnquotedShellComments(cmd, i + 2, true);
      out += sub.text;
      i = sub.next;
      atWordStart = false;
      continue;
    }

    if (ch === "`") {
      out += "`";
      const bt = scanBacktickShellComments(cmd, i + 1);
      out += bt.text;
      i = bt.next;
      atWordStart = false;
      continue;
    }

    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = matchHeredocOpener(cmd.slice(i), "comments");
      if (m) {
        pendingHeredocs.push({ delim: m.delim, stripTabs: m.stripTabs });
        out += cmd.slice(i, i + m.length);
        i += m.length;
        atWordStart = false;
        continue;
      }
    }

    if (ch === "\n") {
      out += "\n";
      i++;
      if (pendingHeredocs.length > 0) {
        const body = consumeShellHeredocBodies(cmd, i, pendingHeredocs);
        out += body.text;
        i = body.next;
        pendingHeredocs.length = 0;
      }
      atWordStart = true;
      continue;
    }

    if (stopAtCloseParen) {
      if (ch === "(") {
        parenDepth++;
        out += ch;
        i++;
        atWordStart = true;
        continue;
      }
      if (ch === ")") {
        if (parenDepth === 1) {
          out += ch;
          return { text: out, next: i + 1 };
        }
        parenDepth--;
        out += ch;
        i++;
        atWordStart = true;
        continue;
      }
    }

    out += ch;
    atWordStart = /[\s;&|()]/.test(ch);
    i++;
  }

  if (stopAtCloseParen) enfLog.debug("scanUnquotedShellComments unclosed command substitution");
  if (pendingHeredocs.length > 0) enfLog.debug("scanUnquotedShellComments pending heredoc at eof", pendingHeredocs.length);
  return { text: out, next: i };
}

/**
 * Strip unquoted shell `#` comments while preserving single/double/`$'...'`
 * quotes, backslash escapes, and heredoc bodies (including inside `$(...)`).
 * Used before `commandHasTrailerByName` so trailing `# Assisted-by:` shell
 * comments never satisfy the commit-trailer check.
 */
export function stripUnquotedShellComments(command: string): string {
  return scanUnquotedShellComments(command, 0, false).text;
}

/**
 * Split a command into segments on shell separators that are *outside* quotes,
 * recording each segment's offset, its parenthesis depth, and whether the
 * separator before it was `||` (so the segment may never run). Quoted text is
 * data, not syntax: a `(` or `cd` inside a string is part of an argument, never
 * a boundary.
 *
 * Depth and conditionality are what let the caller tell a `cd` that moves this
 * shell from one inside a subshell or behind a short-circuit, which change
 * nothing for a later command.
 */
export interface ShellSegment {
  text: string;
  start: number;
  depth: number;
  conditional: boolean;
  /** `cmd &` runs the command in a subshell, so its cd does not move this shell. */
  backgrounded?: boolean;
}

export function unquotedSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  let conditional = false;
  const push = (end: number, startAt: number, cond: boolean, backgrounded = false) => {
    segments.push({
      text: command.slice(startAt, end),
      start: startAt,
      depth,
      conditional: cond,
      ...(backgrounded ? { backgrounded: true } : {}),
    });
  };
  // The index of the first segment in the current `&&`/`||` chain. A trailing
  // `&` backgrounds the whole chain, not just the command beside it.
  let chainStart = 0;
  const chainLen = () => segments.length;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      // A quote spans a newline: `cd "conflicted\nrepo"` is one multi-line path.
      // An unterminated quote is not recovered from here either — bash reports
      // one and runs nothing, and the caller fails closed when no directory
      // can be resolved.
      continue;
    }
    if (ch === "\\" && command[i + 1]) {
      // An escaped character is part of a word: `weird\&name` is one directory
      // name, not a name followed by a background operator.
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // A separator is a single "&&", "||", ";", "|", or newline; "(" and ")"
    // bracket a subshell but are not separators on their own.
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(i, start, conditional);
      // What FOLLOWS a short-circuit may be skipped: `false && cd x` never runs
      // it, and `cd a || cd b` runs the second only if the first failed.
      conditional = true;
      i++;
      start = i + 1;
    } else if (ch === "\n") {
      // An unterminated quote cannot survive a line break in practice; drop the
      // state so one stray apostrophe cannot blind the directory parser for the
      // rest of the command.
      if (quote) {
        enfLog.debug("quote_reset_at_newline", "char", quote);
        quote = null;
      }
      push(i, start, conditional);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === ";") {
      push(i, start, conditional);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "|") {
      // Every pipeline component runs in a subshell of its own, so a directory
      // change on the left of the pipe does not reach the right. Marking it
      // backgrounded is exactly the same rule as a trailing ampersand.
      push(i, start, conditional, true);
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "&") {
      // `2>&1` and `>&2` redirect; a lone `&` backgrounds the whole chain it
      // ends, so every segment of that chain runs in a subshell.
      const redirect = command[i - 1] === ">";
      if (redirect) continue;
      const isDouble = command[i + 1] === "&";
      push(i, start, conditional, !isDouble);
      if (!isDouble) {
        for (let s = chainStart; s < segments.length; s++) segments[s].backgrounded = true;
      }
      conditional = false;
      start = i + 1;
      chainStart = chainLen();
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth > 0) {
        // The closing paren ends the segment it belongs to; only what follows
        // it is back at the outer depth.
        push(i, start, false);
        depth--;
        start = i + 1;
        conditional = false;
      }
    }
  }
  push(command.length, start, conditional);
  enfLog.debug("shell_segments", "count", segments.length);
  return segments;
}

/** The target of a `cd` at the start of a segment, honouring quoting and `~`. */
function cdTargetIn(segment: string): string | null {
  // A cd may follow a shell keyword or a builtin wrapper: `if cd /repo; then …`,
  // `command cd /repo`.
  const m = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)|if\s+|then\s+|else\s+|elif\s+|do\s+|\(\s*|\{\s*)*(?:(?:command|builtin)\s+)*(cd|pushd|popd)\b\s*([\s\S]*)$/.exec(
    segment,
  );
  if (!m) {
    enfLog.debug("cd_target_absent", "segment_head", segment.trim().slice(0, 24));
    return null;
  }
  // `popd` returns to whatever `pushd` displaced, and takes no argument.
  if (m[1] === "popd") return "~popd";
  const args = m[2];
  // Walk the arguments: skip options, then read one destination — a quoted
  // target whole, so a directory name may contain spaces or parentheses.
  let i = 0;
  const skipSpace = () => { while (i < args.length && /\s/.test(args[i])) i++; };
  for (;;) {
    skipSpace();
    if (i >= args.length) break;
    if (args.startsWith("--", i)) { i += 2; continue; }
    // A lone `-` is the previous directory, not an option.
    if (args[i] === "-" && (i + 1 >= args.length || /\s/.test(args[i + 1]))) {
      enfLog.debug("cd_target_previous");
      return "-";
    }
    if (args[i] === "-" && i + 1 < args.length) {
      while (i < args.length && !/\s/.test(args[i])) i++;
      continue;
    }
    if (args[i] === "\\" && i + 1 < args.length) {
      i += 2;
      continue;
    }
    const quote = args[i];
    if (quote === "'" || quote === '"') {
      const end = args.indexOf(quote, i + 1);
      let target = end === -1 ? args.slice(i + 1) : args.slice(i + 1, end);
      i = end === -1 ? args.length : end + 1;
      // The shell concatenates adjacent parts into one word: `cd "work tree"x`
      // is `work treex`, so keep whatever follows the closing quote.
      while (i < args.length && !/[\s;&|)]/.test(args[i])) {
        target += args[i];
        i++;
      }
      // Inside quotes a backslash is literal, so it is doubled here and the
      // caller unescapes it back: `cd 'foo\ bar'` is one directory whose name
      // contains a backslash, not a space.
      const literal = target.replace(/\\/g, "\\\\");
      enfLog.debug("cd_target_quoted", "target", literal);
      return literal;
    }
    let end = i;
    // An escaped character is part of the name: `weird\&name` is one directory.
    while (end < args.length && !/[\s;&|)]/.test(args[end])) {
      if (args[end] === "\\" && end + 1 < args.length) end++;
      end++;
    }
    // Unquoted, a backslash before a newline is a continuation the shell removes
    // entirely. Inside quotes it would be literal, which is why only this path
    // joins and the quoted one above does not.
    const target = args.slice(i, end).replace(/\\\n/g, "");
    enfLog.debug("cd_target", "target", target);
    return target || null;
  }
  // Bare `cd` goes home; `cd -` goes to the previous directory, which the
  // caller resolves against what it tracked.
  enfLog.debug("cd_target_default");
  return "~";
}

/** Apply one directory change to a running directory. */
function applyCd(dir: string, target: string, home = process.env.HOME ?? "~", fromShell = true): string {
  // `cd -` with no previous directory tracked leaves the shell where it is. Only
  // a shell's own `cd -` means that: a directory literally named `-`, reached as
  // `git -C-`, is an ordinary relative directory.
  if (target === "-" && fromShell) {
    enfLog.debug("apply_cd_previous_untracked", "dir", dir);
    return dir;
  }
  let next: string;
  // The shell builds one word from backslash escapes: `weird\&name` is a single
  // directory named `weird&name`, whatever else the name looks like.
  const word = target.replace(/\\(.)/g, "$1");
  if (word.startsWith("~/")) next = join(home, word.slice(2));
  else if (word === "~") next = home;
  else if (word.startsWith("/")) next = word;
  else next = join(dir, word);
  enfLog.debug("apply_cd", "from", dir, "target", target, "to", next);
  return next;
}

/**
 * Every `-C` directory override in a git segment, in order.
 *
 * Only git's *global* options count. `-C` after the subcommand is a different
 * flag entirely — `git commit -C <sha>` reuses that commit's message — so
 * reading it as a directory would send every git safety guard looking for a
 * directory named after a commit, and skip the checks. The walk therefore stops
 * at the first bare word, which is the subcommand.
 */
function gitCsIn(segment: string): string[] {
  const tokens = tokenize(segment);
  const start = tokens.findIndex((w) => w === "git");
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("-") || tok === "-") break;
    if (tok === "-C" || tok.startsWith("-C") && tok.length > 2) {
      const value = tok === "-C" ? tokens[i + 1] : tok.slice(2);
      if (value) values.push(value);
      if (tok === "-C") i++;
      continue;
    }
    // Any other option may take a separate value; skip it if the next word is one.
    if (!tok.includes("=") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
  }
  if (values.length) enfLog.debug("git_C_options", "count", values.length, "last", values[values.length - 1]);
  return values;
}

/** Words that run whatever follows them, so an assignment behind one still counts. */
const WRAPPER_WORDS = new Set(["sudo", "command", "exec", "time", "nohup", "nice", "stdbuf", "setsid", "timeout", "rtk"]);

/** env options whose value is a separate word. */
const ENV_VALUE_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0",
  "--block-signal", "--default-signal", "--ignore-signal", "--debug",
]);

const GIT_INDEX_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]);
const GIT_INDEX_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace"]);

/** Command words that hand a quoted string to a shell, which then really runs it. */
const SHELL_WORDS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);

/** True when this segment RUNS a shell (behind any wrapper/assignment/env prefix).
 *  A quoted argument containing shell-looking text is not a shell run: only the
 *  command word counts. */
export function runsNestedShell(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (WRAPPER_WORDS.has(tok) || tok === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    if (tok.startsWith("-")) {
      // env's own options sit between `env` and the command it runs.
      if (!tok.includes("=") && ENV_VALUE_OPTIONS.has(tok.split("=")[0])) i++;
      continue;
    }
    return SHELL_WORDS.has(tok.replace(/^[()]+/, "").replace(/.*\//, ""));
  }
  return false;
}

/**
 * Anything that points git at a repository other than the working directory: the
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE environment variables, or the equivalent
 * long options. Their target is an index path, not a directory the walker can
 * enumerate, so the caller refuses rather than checks the wrong places.
 *
 * Position matters. An environment variable only selects the index in *assignment
 * position* — `GIT_DIR=/x git add a.txt`, optionally through `env` — so
 * `git add GIT_INDEX_FILE=notes` stages a file with that name. The long options
 * only count in git's global option region, before the subcommand, so
 * `git add -- --work-tree=x` is a filename too.
 */
/** What a scan looks for: the environment variables, git global options, and
 *  `-c` config keys that select the repository or identity git runs with. */
interface GitOverrideTargets {
  /** Variables that count in assignment position. */
  env: Set<string>;
  /** Long options in git's global region, before the subcommand. */
  flags: Set<string>;
  /** Keys of `-c <key>=<value>` / `--config-env=<key>=<VAR>`. */
  configKeys: Set<string>;
}

const NO_KEYS: Set<string> = new Set();

/**
 * The one assignment/option walk behind both git override guards
 * (gitIndexOverride and gitIdentityOverride). Returns a label for what it found,
 * or null.
 *
 * Position matters. An environment variable only counts in *assignment
 * position* — `GIT_DIR=/x git add a.txt`, optionally through `env` — so
 * `git add GIT_INDEX_FILE=notes` stages a file with that name. Options only
 * count in git's global region before the subcommand, so
 * `git add -- --work-tree=x` is a filename too.
 */
function scanGitOverrides(command: string, targets: GitOverrideTargets): string | null {
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const nameOf = (tok: string) => tok.split("=")[0];
  for (const seg of unquotedSegments(command)) {
    const tokens = tokenize(seg.text);
    let i = 0;
    // `export GIT_INDEX_FILE=/x` sets it for later commands in the same shell,
    // so it points git at another index just as an inline assignment does. This
    // segment does not run git itself, so it is checked before that requirement.
    // The executable view of a nested shell wraps a segment in `(`, so `(export`
    // is the same word.
    if (tokens[i]?.replace(/^\(+/, "") === "export") {
      i++;
      while (i < tokens.length) {
        const name = nameOf(tokens[i]);
        if (targets.env.has(name)) {
          enfLog.warn("git_override", "source", name, "via", "export");
          return name;
        }
        i++;
      }
      continue;
    }
    // `echo GIT_INDEX_FILE=/x` only prints the name. An override is something
    // git is actually run with, so the segment has to run git for it to count —
    // directly, or through a nested shell that this segment RUNS
    // (`GIT_AUTHOR_EMAIL=x bash -c 'git commit'`), whose assignment lives here
    // but whose git runs inside. A quoted argument merely MENTIONING a command
    // (`gh pr create --body "…git -c user.email=x commit…"`) is prose: the
    // segment runs `gh`, not a shell, so it is not followed.
    if (!segmentRunsGit(seg.text) && !(runsNestedShell(tokens) && segmentRunsGit(executableText(seg.text)))) continue;
    // Leading `VAR=value` assignments, then the same again after `env`. A
    // wrapper that runs the rest — `sudo`, `command`, `exec`, `time` — sits in
    // front of both, and can be chained.
    for (let round = 0; round < 4; round++) {
      // A wrapper runs the rest, and its OWN options sit in between: in
      // `rtk -v GIT_AUTHOR_EMAIL=x git commit` the assignment follows rtk's
      // option, so stepping only over the wrapper word hid it (Qodo, PR #996).
      while (i < tokens.length && WRAPPER_WORDS.has(tokens[i])) {
        i++;
        while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
          i += WRAPPER_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
        }
      }
      while (i < tokens.length && assignment.test(tokens[i])) {
        const name = nameOf(tokens[i]);
        if (targets.env.has(name)) {
          enfLog.warn("git_override", "source", name);
          return name;
        }
        i++;
      }
      if (tokens[i] !== "env") break;
      i++;
      // env's own options: only these take a separate value, and that value must
      // not be read as an assignment or as the command. `-i` takes none, so
      // treating every option as value-taking would swallow the assignment after it.
      while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
        const opt = tokens[i].split("=")[0];
        if (!tokens[i].includes("=") && ENV_VALUE_OPTIONS.has(opt)) i++;
        i++;
      }
    }
    // A segment can start mid-subshell, so `(git` is the git word too.
    const g = tokens.findIndex((t) => t.replace(/^[()]+|[()]+$/g, "") === "git");
    if (g === -1) continue;
    for (let k = g + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (!tok.startsWith("-") || tok === "-") break;
      // `-c <key>=<value>`, `-c<key>=<value>`, `--config-env=<key>=<VAR>` apply to
      // this one command only — no config file is written, the effect is the same.
      let setting: string | undefined;
      if (tok === "-c") setting = tokens[++k];
      else if (tok.startsWith("-c")) setting = tok.slice(2);
      else if (tok.startsWith("--config-env=")) setting = tok.slice("--config-env=".length);
      if (setting !== undefined) {
        const key = (setting.split("=")[0] ?? "").toLowerCase();
        if (targets.configKeys.has(key)) {
          const label = tok.startsWith("--config-env") ? `--config-env ${key}` : `-c ${key}`;
          enfLog.warn("git_override", "source", label);
          return label;
        }
        continue;
      }
      const name = nameOf(tok);
      if (targets.flags.has(name)) {
        enfLog.warn("git_override", "source", name);
        return name;
      }
      if (!tok.includes("=") && tokens[k + 1] && !tokens[k + 1].startsWith("-")) k++;
    }
  }
  return null;
}

function gitIndexOverride(command: string): string | null {
  const found = scanGitOverrides(command, { env: GIT_INDEX_VARS, flags: GIT_INDEX_OPTIONS, configKeys: NO_KEYS });
  if (found) enfLog.warn("git_index_override", "source", found);
  return found;
}

/** Environment variables that set who a commit is recorded as. */
const GIT_IDENTITY_VARS = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** Git config keys that set who a commit is recorded as. */
const GIT_IDENTITY_KEYS = new Set([
  "user.name", "user.email", "author.name", "author.email", "committer.name", "committer.email",
]);

/** `git config` flags that only READ: `git config --get user.email` changes nothing. */
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

/** `git config` flags that remove a key: no value follows, yet the identity moves. */
const CONFIG_UNSET_FLAGS = new Set(["--unset", "--unset-all"]);

const bashWritesReCache = new Map<string, { structural: RegExp; quoted: RegExp }>();
const BASH_WRITES_RE_CACHE_MAX = 32;

function getBashWritesRegexes(targetSrc: string): { structural: RegExp; quoted: RegExp } {
  const cached = bashWritesReCache.get(targetSrc);
  if (cached) return cached;
  const structuralSrc = String.raw`>+\|?\s*\S*${targetSrc}|(?:^|[\s;&|(])(?:tee|sponge)(?:\s+-[A-Za-z-]+)*\s+\S*${targetSrc}`;
  const quotedSrc = String.raw`>+\s*["'][^"']*${targetSrc}|(?:^|[\s;&|(])(?:tee|sponge)(?:\s+-[A-Za-z-]+)*\s+["'][^"']*${targetSrc}`;
  const pair = { structural: new RegExp(structuralSrc, "i"), quoted: new RegExp(quotedSrc, "i") };
  if (bashWritesReCache.size >= BASH_WRITES_RE_CACHE_MAX) {
    const oldest = bashWritesReCache.keys().next().value;
    if (oldest !== undefined) bashWritesReCache.delete(oldest);
  }
  bashWritesReCache.set(targetSrc, pair);
  return pair;
}

/**
 * True when a bash command WRITES into a path matching `targetSrc` (a regex
 * source): a redirect (`>`, `>>`, `>|`) or `tee`/`sponge` taking it as an
 * argument. Deliberately NARROW (user decision on issue #949 R3): broad
 * write-verb co-occurrence taxed legitimate work and any text guard is
 * bypassable anyway — this catches the lazy one-liner.
 *
 * Redirect STRUCTURE is read from the prose-masked command; quoted targets are
 * invisible once masked, so those are matched on the raw command (Qodo #950 R5).
 */
export function bashWritesToPath(command: string, maskedCommand: string, targetSrc: string): boolean {
  const { structural, quoted } = getBashWritesRegexes(targetSrc);
  let result = structural.test(maskedCommand) || quoted.test(command);
  if (!result) {
    // A nested shell's script is code, not prose, so a redirect inside it
    // (`bash -c 'echo x >> .git/config'`) still writes the file. Only segments
    // that RUN a shell are read this way — a quoted argument merely describing
    // a command stays prose (Qodo, PR #996).
    for (const seg of unquotedSegments(command)) {
      if (!runsNestedShell(tokenize(seg.text))) continue;
      if (structural.test(executableText(seg.text))) {
        result = true;
        break;
      }
    }
  }
  enfLog.debug("bash_writes_to_path", targetSrc, result);
  return result;
}


const IDENTITY_TARGETS: GitOverrideTargets = {
  env: GIT_IDENTITY_VARS,
  flags: NO_KEYS,
  configKeys: GIT_IDENTITY_KEYS,
};

/**
 * Anything that sets the identity a commit is recorded under (issue #995): the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables in assignment
 * position, a
 * per-command `git -c user.name=...`, a `git config` WRITE of an identity key,
 * or `git commit --author`. The identity belongs to the human — an agent that
 * can change it forges commits in someone else's name.
 *
 * Returns a label of what was found, or null.
 *
 * shortcut: a `-c` key held in a shell variable (`-c "$VAR=x"`) does not match,
 * and a quoted value nested two shells deep is seen only if the outer view keeps
 * it parseable — upgrade if either shows up in the wild.
 */
export function gitIdentityOverride(command: string): string | null {
  // A nested shell string (`bash -c '...'`, `eval`) really runs, so both views
  // are checked: the raw text keeps quoted option VALUES parseable
  // (`-c "user.name=x"`), the executable view exposes what a nested shell runs.
  const executable = executableText(command);
  for (const text of executable && executable !== command ? [command, executable] : [command]) {
    const found = scanGitOverrides(text, IDENTITY_TARGETS) ?? identityWritesIn(text);
    if (found) {
      enfLog.warn("git_identity_override", "source", found);
      return found;
    }
  }
  enfLog.debug("git_identity_override", "none", command.length);
  return null;
}

/**
 * The two identity writes the prefix scan cannot see: `git config <identity key>
 * <value>` (written to disk for every later commit) and `git commit --author`
 * (this one commit recorded as somebody else).
 */
function identityWritesIn(command: string): string | null {
  // `git config user.email x` — the identity written to disk for every later commit.
  for (const region of gitSubArgRegions(command, "config")) {
    // Tokens come from the RAW region: tokenize() drops the quotes but keeps a
    // quoted value as one token, so `git config user.email "a@b"` and
    // `git config "user.email" a@b` are both seen, while a value that merely
    // MENTIONS the key stays a single token and is never a key (Qodo, PR #996).
    const tokens = tokenize(region);
    if (tokens.some((t) => CONFIG_READ_FLAGS.has(t))) continue;
    const at = tokens.findIndex((t) => GIT_IDENTITY_KEYS.has(t.toLowerCase()));
    if (at === -1) continue;
    // A key alone is a READ (`git config user.email` prints it): only a value
    // after it, or an unset, changes the identity.
    const writes = tokens.some((t) => CONFIG_UNSET_FLAGS.has(t))
      || tokens.slice(at + 1).some((t) => !t.startsWith("-"));
    if (writes) return `git config ${tokens[at].toLowerCase()}`;
  }
  // `git commit --author` — this one commit is recorded as somebody else.
  for (const region of gitSubArgRegions(command, "commit")) {
    // Raw region again: `--author 'A <a@b>'` and `"--author" x` are options the
    // shell passes to git, while a `-m` message mentioning --author is ONE token.
    const tokens = tokenize(region);
    const at = tokens.findIndex((t) => t === "--author" || t.startsWith("--author="));
    if (at === -1) continue;
    // A bare `--author` with no value after it sets nothing.
    if (tokens[at].includes("=") || (tokens[at + 1] !== undefined && !tokens[at + 1].startsWith("-"))) {
      return "--author";
    }
  }
  return null;
}

/**
 * A path that IS git's identity configuration: `~/.gitconfig`, the XDG
 * `~/.config/git/config`, or a repository's `.git/config`. Writing one of these
 * changes the identity every later commit is recorded under, so agents are kept
 * away from them entirely.
 * The two home files count only under THIS user's home — a `.gitconfig` in
 * /tmp or a docs fixture is not the identity git reads (Qodo, PR #996).
 */
/**
 * Regex source matching a git identity config path as WRITTEN in a shell
 * command — `$HOME`/`~`/absolute home forms and repo-local `.git/config`.
 * One source of truth for the tripwire and its tests (Qodo, PR #996).
 */
let cachedIdentityConfigSrc: { home: string; src: string } | null = null;

export function gitIdentityConfigSrc(): string {
  const home = homedir();
  if (cachedIdentityConfigSrc && cachedIdentityConfigSrc.home === home) {
    return cachedIdentityConfigSrc.src;
  }
  const homeSrc = escapeRegExp(home.replace(/\\/g, "/"));
  const src = String.raw`(?:(?:~|\$HOME|\$\{HOME\}|${homeSrc})/(?:\.gitconfig|\.config/git/config)|\.git/config)(?![A-Za-z0-9._-])`;
  cachedIdentityConfigSrc = { home, src };
  return src;
}

export function isGitIdentityConfigPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dir = norm.slice(0, Math.max(norm.lastIndexOf("/"), 0));
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  const inHome = dir === home || dir === "~";
  const result =
    (inHome && base === ".gitconfig")
    || norm === `${home}/.config/git/config`
    || norm === "~/.config/git/config"
    || /(?:^|\/)\.git\/config$/.test(norm);
  enfLog.debug("is_git_identity_config_path", p, result);
  return result;
}

/**
 * Every directory the command could plausibly run git in.
 *
 * Candidates come from where git actually runs: the directory in effect at each
 * git invocation, plus every `-C` resolved in order from that directory (git
 * applies them one after another), plus any directory a `cd` reached only
 * conditionally. Each subshell gets its own directory stack, because a `cd`
 * inside one cannot move the outer shell — which is also why a `cd` in a
 * subshell contributes a candidate without becoming the running directory.
 *
 * When an environment variable selects the index, the target is unknowable and
 * `envOverride` says so, so the caller can refuse instead of guess.
 */
export function conflictCandidateDirs(
  command: string,
  sessionCwd: string,
): { all: string[]; envOverride: string | null; dynamicPath: string | null } {
  const envOverride = gitIndexOverride(command);
  // A path the shell expands at run time — `$DIR`, `$(pwd)`, a glob — cannot be
  // checked here, so it is reported rather than resolved to a literal. A glob
  // character the command escaped is part of the name, not a pattern.
  const dynamic = (p: string) => /[$*?{]/.test(p.replace(/\\./g, ""));
  let dynamicPath: string | null = null;
  // Per paren depth: is the directory this shell is in one we could not resolve?
  // A subshell's answer dies with the subshell, which is what makes a completed
  // subshell stop mattering.
  const dynamicAt: boolean[] = [false];
  // Set when a command that stages ran in a directory we could not resolve. That
  // is the case worth refusing: we do not know what it staged. A read-only
  // command in the same directory is not, so it does not pin the refusal.
  let unresolvedStaging = false;
  const dirs = new Set<string>();
  // running[d] is the directory of the shell at paren depth d.
  const running: string[] = [sessionCwd];
  // OLDPWD: where the shell was before the last change, which is what `cd -`
  // returns to. Each depth has its own, and each starts where the shell did —
  // the shell's own PWD, not just the directory we were invoked from.
  const startPwd = process.env.PWD && process.env.PWD.startsWith("/") ? process.env.PWD : sessionCwd;
  const previous: string[] = [startPwd];
  // What `pushd` displaced, per depth, for `popd` to return to.
  const pushed: string[][] = [[]];
  // `HOME=/x git add a.txt` sends a bare `cd` and a `~` somewhere else, so the
  // command's own assignment wins over this process's environment.
  let home = process.env.HOME ?? "~";
  // Walk the *executable* text: a `cd` inside a `bash -c` script, or inside a
  // command substitution, moves the directory the staging really runs in.
  const scan = executableText(command) || command;

  for (const seg of unquotedSegments(scan)) {
    // Leaving a subshell discards its directory, and entering a new one starts
    // from the outer shell again — otherwise `(cd clean); (git add x)` would
    // inherit `clean` for the second subshell.
    if (running.length > seg.depth + 1) running.length = seg.depth + 1;
    while (running.length <= seg.depth) running.push(running[running.length - 1]);
    while (previous.length <= seg.depth) previous.push(previous[previous.length - 1]);
    while (pushed.length <= seg.depth) pushed.push([]);
    while (dynamicAt.length <= seg.depth) dynamicAt.push(dynamicAt[dynamicAt.length - 1]);
    const assigned = /(?:^|[\s;&|(])HOME=(\S*)/.exec(seg.text);
    if (assigned) home = assigned[1];
    const target = cdTargetIn(seg.text);
    if (target) {
      if (seg.conditional || seg.backgrounded) {
        // Behind a short-circuit the cd may never run, and a backgrounded cd
        // runs in its own subshell — so in both cases the directory the shell is
        // in *before* it is where a later command actually stages.
        dirs.add(running[seg.depth]);
      }
      const from = running[seg.depth];
      // `cd -` goes to OLDPWD as it stands *before* this change, and only then
      // does the previous directory become where we are now.
      let to: string;
      if (target === "-") to = previous[seg.depth];
      else if (target === "~popd") {
        const stack = pushed[seg.depth];
        to = stack.length ? stack.pop()! : from;
      } else {
        to = applyCd(from, target, home);
        // A bare `pushd` pushes where we are and goes home, the same as a bare
        // `cd`; a `cd` leaves the push stack alone.
        if (/\bpushd\b/.test(seg.text) && !/^\s*(?:if\s+|then\s+|else\s+|elif\s+|do\s+|\(\s*|\{\s*)*pushd\s+\S/.test(seg.text)) {
          pushed[seg.depth].push(from);
        }
      }
      if (seg.backgrounded) {
        // The subshell moves; this shell does not.
        dirs.add(to);
      } else {
        previous[seg.depth] = from;
        running[seg.depth] = to;
      }
      // An expanded target leaves the directory unresolved. A relative move
      // inherits that from where it started; an absolute literal path settles it.
      dynamicAt[seg.depth] =
        dynamic(target) || (!target.startsWith("/") && dynamicAt[seg.depth]);
      if (!seg.conditional && !seg.backgrounded && target.startsWith("/") && !dynamic(target) && !unresolvedStaging) {
        // Once a staging command has already run in an unresolved directory, the
        // path stays reported: the refusal has to name the path we could not read.
        dynamicPath = null;
      }
      if (dynamic(target) && !dynamicPath) dynamicPath = target;
    }
    if (segmentRunsGit(seg.text)) {
      let base = running[seg.depth];
      // `env -C dir git add x` moves git into dir without a shell cd.
      const envChdir = /^\s*(?:VAR=\S*\s*)*env\s+(?:-\S+\s+)*?(?:-C|--chdir)(?:[=\s]+)(\S+)/.exec(seg.text);
      if (envChdir) base = applyCd(base, envChdir[1], home);
      dirs.add(base);
      // Git applies each -C in turn, each relative to the previous one.
      const overrides = gitCsIn(seg.text);
      let cursor = base;
      for (const c of overrides) {
        // An expanded override is the directory this invocation actually runs
        // in, so it is the one worth reporting over an earlier cd target.
        if (dynamic(c)) dynamicPath = c;
        // A directory literally named `-` is ordinary; only the shell's own
        // `cd -` means the previous directory.
        cursor = applyCd(cursor, c, home, false);
        dirs.add(cursor);
      }
      // Where this invocation actually runs decides whether it is unresolved. A
      // final absolute override names the worktree outright, so a directory the
      // shell merely expanded on its way there is irrelevant to it.
      const stages = isConflictResolutionCommand(seg.text);
      const lastOverride = overrides[overrides.length - 1];
      const named = lastOverride !== undefined && !dynamic(lastOverride) && lastOverride.startsWith("/");
      if (stages && !named) {
        if (dynamicAt[seg.depth] || overrides.some((c) => dynamic(c))) unresolvedStaging = true;
      }
  }
  }
  const all = [...dirs];
  // Only a command that staged while the directory was unresolved is worth
  // refusing. Otherwise the path was resolved, or only read from, by the end.
  const unresolved = unresolvedStaging ? dynamicPath : null;
  enfLog.debug("conflict_candidate_dirs", "count", all.length, "env_override", envOverride ?? "none", "dynamic_path", unresolved ?? "none", "unresolved_staging", unresolvedStaging);
  return { all, envOverride, dynamicPath: unresolved };
}

/** Parse bash command for cd target to resolve the effective working directory (worktree support) */
export function resolveEffectiveCwd(command: string, sessionCwd: string): string {
  // Quoting decides what is syntax, so segments are split outside quotes first.
  // Then the LAST cd before the git invocation, applied in shell order so a
  // chain of relative cds composes. Two cases make the obvious implementations
  // wrong:
  //   (cd clean && cd conflicted && git add x)  → the later cd wins
  //   cd /repo && git commit && cd /tmp          → a trailing cd must not
  // With no git invocation to anchor to, the first cd is used, which is the
  // conservative answer for `cd a && cd b && pytest`.
  //
  // A command that can run git in more than one directory (a conditional branch,
  // a completed subshell, several invocations) has no single answer here. That
  // is why conflict enforcement asks conflictCandidateDirs instead of trusting
  // this function's guess.
  const segments = unquotedSegments(command);
  // A segment only counts when it *runs* git: `cd ~/git/proj` merely contains
  // the word, and anchoring on it would drop a real directory change.
  const gitIndex = segments.findIndex((s) => segmentRunsGit(s.text));
  // Only a cd that moves *this* shell counts. A cd inside a subshell, or one
  // behind a short-circuit, runs somewhere else or may not run at all, so
  // applying it sent the guards looking at a directory the shell never entered —
  // `(cd /tmp) && git commit` read /tmp settings, where enforcement is off.
  const targetDepth = gitIndex === -1 ? 0 : segments[gitIndex].depth;
  const running: string[] = [sessionCwd];
  const applied: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    // A trailing cd after the git command did not happen yet.
    if (i === gitIndex) break;
    const seg = segments[i];
    // A segment deeper than the git command runs in a subshell that has already
    // closed by the time git runs, so it cannot have moved this shell. It is
    // skipped rather than ending the walk: a subshell before the command is
    // ordinary, and stopping there would drop every later directory change.
    if (seg.depth > targetDepth) continue;
    while (running.length <= seg.depth) running.push(running[running.length - 1]);
    const target = cdTargetIn(seg.text);
    if (!target || target === "~popd") continue;
    // A change at a shallower depth still counts: `cd /protected && (git commit)`
    // enters /protected first, and the subshell inherits it. Only deeper segments
    // were ruled out above, because those run in a subshell that has closed by
    // the time git runs. Note that a change behind a short-circuit still counts:
    // `cd a && cd b` really does leave the shell in b, and `if cd x; then` leaves
    // it in x too.
    running[seg.depth] = applyCd(running[seg.depth], target);
    applied.push(target);
    // With no git invocation to anchor to, the first cd is the conservative
    // answer for `cd a && cd b && pytest`.
    if (gitIndex === -1) break;
  }
  // The git segment itself was never walked, so a subshell depth it introduced
  // has no entry yet. It inherits the directory of the shell that spawned it.
  while (running.length <= targetDepth) running.push(running[running.length - 1]);
  let dir = running[targetDepth];
  const envShifts = gitIndex === -1 ? { envDirs: [], gitDirs: [], opaque: false } : segmentDirShifts(segments[gitIndex].text);
  for (const envTarget of envShifts.envDirs) dir = applyCd(dir, envTarget);
  // Git applies each -C in turn, each relative to the previous one, so
  // `git -C worktree -C nested` lands in worktree/nested.
  const cTargets = gitIndex === -1 ? [] : gitCsIn(segments[gitIndex].text);
  for (const cTarget of cTargets) dir = applyCd(dir, cTarget, process.env.HOME ?? "~", false);
  enfLog.debug("effective_cwd", "dir", dir, "source", cTargets.length ? "git_C" : envShifts.envDirs.length ? "env_C" : applied.length ? "cd" : "session", "cds", applied.length);
  return dir;
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

const REMOTE_EXEC_REASON = "\u26d4 Remote script execution is forbidden. Download the script first, audit it with security-auditor, then run if safe.";
const REMOTE_PIPE_SHELL_RE = /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(ba|c|da|[akz]|fi|tc)?sh\b/;
const REMOTE_PIPE_INTERP_RE = /\b(curl|wget)\b.*\|(?!\|)\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*|uv\s+run\s+)*(?:\/\S+\/)*(python[23]?|perl|ruby|node|deno|bun)\b/;
const REMOTE_PROCSUB_CMD_RE = /\b(?:(?:ba|c|da|[akz]|fi|tc)?sh|python[23]?|perl|ruby|node|deno|bun)\b.*<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/;
const REMOTE_PROCSUB_SRC_RE = /\bsource\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/;
const REMOTE_PROCSUB_DOT_RE = /(?:^|[\s;&|])\.\s+<\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/;
const REMOTE_HEREDOC_TAIL_RE = /<<-?\s*['"]?(\w+)['"]?[\s\S]*/m;

const REMOTE_SAFE_ASSIGN_SRC = (() => {
  const qDouble = /"(?:(?!\$\()[^"`])*"/.source;
  const qSingle = /'(?:(?!\$\()[^'`])*'/.source;
  const dollarSub = String.raw`\$\((?:` + qDouble + `|` + qSingle + String.raw`|(?!\$\()(?!` + "`" + String.raw`)[^)])*\)`;
  const backtickSub = "`(?:(?!\\$\\()[^`])*`";
  const captureValue = `(?:${dollarSub}|${backtickSub})`;
  return (
    String.raw`(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?([a-z_]\w*)=(` +
    captureValue + String.raw`)(?=\s*(?:$|[;&|#\n)}]))`
  );
})();
const REMOTE_SAFE_ASSIGN_RE = new RegExp(REMOTE_SAFE_ASSIGN_SRC, "gi");
const REMOTE_CURL_DOLLAR_SUB_RE = /\$\((?:"[^"]*"|'[^']*'|[^)"'])*\b(curl|wget)\b/;
const REMOTE_CURL_BACKTICK_SUB_RE = /`[^`]*\b(curl|wget)\b/;

const {
  INLINE_EVAL_RE,
  INLINE_SHELL_RE,
  INLINE_INTERP_RE,
  VAR_FLOW_EVAL_RE,
  VAR_FLOW_SHELL_RE,
  VAR_FLOW_INTERP_RE,
  UNTRACKABLE_SHELL_RE,
  UNTRACKABLE_INTERP_RE,
} = (() => {
  const assignPrefix = /(?:[a-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/.source;
  const cmdPos = /(?:^|[;&|\n({]|&&|\|\||\$\(|\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source + assignPrefix + /(?:sudo\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*)*/.source + assignPrefix;
  const redirections = /(?:(?:[0-9]*>[>&]?|<)\s*\S+\s+)*/.source;
  const pathPrefix = /(?:\/\S+\/)*/.source;
  const wrappers = /(?:(?:command|builtin|exec)\s+|uv\s+run\s+)*/.source;
  const execPrefix = cmdPos + redirections + wrappers;
  const shellExec = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+-c\b|\s+<<<|\s+<[^<])/.source;
  const interpExec = /(?:python[23]?|perl|ruby|node|deno|bun)(?:\s+-[ce]\b|\s+<\()/.source;
  const dollarArg = /[^\n;&|]*\$/.source;
  const shellStdin = /(?:ba|c|da|[akz]|fi|tc)?sh(?:\s+<<<|\s+<[^<]|\s+<\()/.source;
  const interpStdin = /(?:python[23]?|perl|ruby|node|deno|bun)\s+<\(/.source;
  return {
    INLINE_EVAL_RE: new RegExp(execPrefix + /eval(?:\s|$)/.source),
    INLINE_SHELL_RE: new RegExp(execPrefix + pathPrefix + shellExec),
    INLINE_INTERP_RE: new RegExp(execPrefix + pathPrefix + interpExec),
    VAR_FLOW_EVAL_RE: new RegExp(execPrefix + /eval\b/.source + dollarArg),
    VAR_FLOW_SHELL_RE: new RegExp(execPrefix + pathPrefix + shellExec + dollarArg),
    VAR_FLOW_INTERP_RE: new RegExp(execPrefix + pathPrefix + interpExec + dollarArg),
    UNTRACKABLE_SHELL_RE: new RegExp(execPrefix + pathPrefix + shellStdin),
    UNTRACKABLE_INTERP_RE: new RegExp(execPrefix + pathPrefix + interpStdin),
  };
})();

const REMOTE_BARE_SUB_DOLLAR_RE = /\$\(\s*\b(curl|wget)\b/;
const REMOTE_BARE_SUB_BACKTICK_RE = /`\s*\b(curl|wget)\b/;
const REMOTE_ENV_VAR_SUB_RE = /\benv\s+.*[a-z_]\w*=(?:\$\(|`).*\b(curl|wget)\b/;
const REMOTE_SAFE_ASSIGN_BARE_RE = /(?:^|(?<=[;&|\n({])\s*)(?:export\s+|declare\s+|local\s+|readonly\s+|typeset\s+)?[a-z_]\w*=(?:\$\((?:"[^"]*"|'[^']*'|(?!\$\()(?!`)[^)])*\)|`(?:(?!\$\()[^`])*`)(?=\s*(?:$|[;&|#\n)}]))/gi;
const REMOTE_WORD_RE = /\b(curl|wget)\b/;

/** Block remote script execution (pipe to shell, process substitution, command substitution/eval) */
export function checkRemoteExecBlock(cmdLower: string): EnforcementResult {
  if (!cmdLower.includes("curl") && !cmdLower.includes("wget")) return undefined;
  const cmdForExecCheck = cmdLower.replace(REMOTE_HEREDOC_TAIL_RE, "");
  if (REMOTE_PIPE_SHELL_RE.test(cmdForExecCheck) || REMOTE_PIPE_INTERP_RE.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "pipe");
    return { block: true, reason: REMOTE_EXEC_REASON };
  }
  if (REMOTE_PROCSUB_CMD_RE.test(cmdForExecCheck) ||
      REMOTE_PROCSUB_SRC_RE.test(cmdForExecCheck) ||
      REMOTE_PROCSUB_DOT_RE.test(cmdForExecCheck)) {
    enfLog.debug("remote_exec_block", "proc-sub");
    return { block: true, reason: REMOTE_EXEC_REASON };
  }
  const curlVars = new Set<string>();
  REMOTE_SAFE_ASSIGN_RE.lastIndex = 0;
  for (const m of cmdForExecCheck.matchAll(REMOTE_SAFE_ASSIGN_RE)) {
    if (REMOTE_WORD_RE.test(m[2])) curlVars.add(m[1]);
  }
  const strippedForSub = cmdForExecCheck.replace(REMOTE_SAFE_ASSIGN_RE, " ");
  const hasCurlSub = REMOTE_CURL_DOLLAR_SUB_RE.test(strippedForSub) || REMOTE_CURL_BACKTICK_SUB_RE.test(strippedForSub);
  if (hasCurlSub || curlVars.size > 0) {
    if (hasCurlSub && (
        INLINE_EVAL_RE.test(cmdForExecCheck) ||
        INLINE_SHELL_RE.test(cmdForExecCheck) ||
        INLINE_INTERP_RE.test(cmdForExecCheck))) {
      enfLog.debug("remote_exec_block", "inline-sub");
      return { block: true, reason: REMOTE_EXEC_REASON };
    }
    if (curlVars.size > 0) {
      if (VAR_FLOW_EVAL_RE.test(cmdForExecCheck) ||
          VAR_FLOW_SHELL_RE.test(cmdForExecCheck) ||
          VAR_FLOW_INTERP_RE.test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "var-flow");
        return { block: true, reason: REMOTE_EXEC_REASON };
      }
      if (UNTRACKABLE_SHELL_RE.test(cmdForExecCheck) ||
          UNTRACKABLE_INTERP_RE.test(cmdForExecCheck)) {
        enfLog.debug("remote_exec_block", "untrackable");
        return { block: true, reason: REMOTE_EXEC_REASON };
      }
    }
  }
  if (REMOTE_BARE_SUB_DOLLAR_RE.test(cmdForExecCheck) || REMOTE_BARE_SUB_BACKTICK_RE.test(cmdForExecCheck)) {
    if (REMOTE_ENV_VAR_SUB_RE.test(cmdForExecCheck)) {
      enfLog.debug("remote_exec_block", "env-var-sub");
      return { block: true, reason: REMOTE_EXEC_REASON };
    }
    const stripped = cmdForExecCheck.replace(REMOTE_SAFE_ASSIGN_BARE_RE, " ");
    if (REMOTE_BARE_SUB_DOLLAR_RE.test(stripped) || REMOTE_BARE_SUB_BACKTICK_RE.test(stripped)) {
      enfLog.debug("remote_exec_block", "bare-sub");
      return { block: true, reason: REMOTE_EXEC_REASON };
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
  "echo", "printf", "ls",
]);

/**
 * Replace single-quoted regions with '' so substitutions inside them are
 * invisible to the scanner, while a ' inside double quotes stays literal
 * (Qodo PR #948: the old /'[^']*'/g regex treated an apostrophe inside "..."
 * as an opening quote and swallowed everything up to the next apostrophe,
 * hiding executable substitutions like $(rm -rf ...) from extraction).
 * An UNTERMINATED single-quote region is re-emitted raw: a stray apostrophe
 * ("it's fine $(rm -rf /)") must not hide the substitution that follows.
 */
function stripSingleQuotedRegions(stmt: string): string {
  return scanQuotedRegions(stmt, "strip-single");
}

/**
 * Replace the CONTENT of quoted regions ('...', "...") with a single space,
 * keeping the delimiters, so filename/redirect guards see shell STRUCTURE
 * without prose (Qodo PR #950 R5: `--body "settings => pi-config-settings.json"`
 * must not trip the redirect tripwire). Backslash-escape aware (\" never toggles
 * a quote); an UNTERMINATED quoted region is re-emitted raw — a stray quote
 * must not hide the rest of the command from the guards.
 */
export function maskQuotedRegions(cmd: string): string {
  return scanQuotedRegions(cmd, "mask-all");
}

/**
 * Extract command substitutions ($(...), `...`) and process substitutions
 * (<(...), >(...)) from a statement, respecting single quotes (which
 * suppress expansion in bash). Returns the extracted command strings.
 */
export function extractSubshells(stmt: string): string[] {
  const results: string[] = [];

  // Strip single-quoted regions — POSIX sh has no escape inside single quotes.
  // Double-quote-aware so a literal apostrophe inside "..." cannot open a
  // quoted region (Qodo PR #948).
  const withoutSingleQuoted = stripSingleQuotedRegions(stmt);

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
        results.push(stripSingleQuotedRegions(withoutSingleQuoted.slice(start, j - 1)));
      }
      i = j;
      continue;
    }
    // Backtick substitution — skip escaped backticks (\`)
    if (withoutSingleQuoted[i] === "`") {
      const close = scanBacktickEnd(withoutSingleQuoted, i);
      if (close !== null) {
        results.push(stripSingleQuotedRegions(withoutSingleQuoted.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return results;
}

/**
 * Transparent wrapper prefixes that may precede the real command without
 * changing its read-only nature (issue #947). Mirrors the git-code wrapper
 * set (GIT_RTK_SRC et al., PR #916) — the user-level rtk extension rewrites
 * every bash command through `rtk rewrite` before enforcement evaluates it,
 * so `grep` arrives as `rtk grep`.
 *
 * Deliberately NOT sudo: a sudo-prefixed command must never receive a
 * silent read-only pass (the DANGEROUS sudo pattern still prompts).
 */
const READ_ONLY_WRAPPER_PREFIX_RE =
  // env/nice option handling is PRECISE about which flags take values
  // (PR #948 R2): generic value consumption would let `env -i grep foo`
  // eat `grep` as -i's "value", while no value consumption lets
  // `env -u grep rm -rf x` pass `grep` off as the command. env's value-taking
  // options are -u/-C/-S/-P (and long forms); -i is boolean. nice's only
  // value option is -n/--adjustment.
  // `-S`/`--split-string` is deliberately NOT consumable (PR #948 R3): its
  // "value" is a split command line (`env -S find ls -delete` runs find), so
  // an env -S statement never gets a read-only pass — it falls through to
  // the DANGEROUS pattern check instead.
  /^\s*(?:\S+=\S*\s+|rtk(?:\s+-\S+)*\s+|(?:command|builtin|exec)\s+|env(?:\s+(?:-(?:u|C|P)(?:\s+\S+)?|-i|--ignore-environment|--unset(?:\s+\S+)?|--chdir[= ]\S*|\S+=\S*))*\s+|timeout\s+(?:-\S+\s+)*\S+\s+|nice(?:\s+(?:-n\s+\S+|--adjustment[= ]\S*))*\s+|nohup\s+)+/;

/**
 * Split a command into individual statements for the dangerous-command
 * check: strip heredoc bodies, collapse line continuations, then split on
 * statement separators AND pipes. Single `&` (background operator) is a
 * separator too (Qodo PR #948): `echo ok & rm -rf x` must not let a
 * read-only verdict for `echo` skip the deletion that follows it.
 * `&&` and `||` are matched before `&`/`|` by alternation order.
 * NOTE: Pipe split does not respect shell quoting — biases toward false
 * positives (extra prompts), which is acceptable for security.
 */
export function splitBashStatements(command: string): string[] {
  // Split on statement separators AND pipes. Single `&` (background operator)
  // is a separator too (Qodo PR #948), EXCEPT inside a descriptor-duplication
  // redirect (`2>&1`, `>&2` — PR #948 R3): splitting those at `&` shatters the
  // redirect and hides a piped shell behind harmless fragments. `&&` and `||`
  // are matched before `&`/`|` by alternation order.
  // NOTE: Pipe split does not respect shell quoting — biases toward false
  // positives (extra prompts), which is acceptable for security.
  const normalized = stripHeredocBodies(command).replace(/\\\r?\n/g, " ");
  return normalized
    .split(/\n|;|&&|(?<!>)&|\|\||\|/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

/**
 * User-approved allowlist for recurring legitimate dangerous-looking commands
 * (issue #949, PR #950). Entries live in the `dangerous_command_allowlist`
 * setting (project `.pi/pi-config-settings.json(c)`, global `~/.pi/...`) so
 * the user can inspect, edit, and extend them — including wildcards:
 * `*` matches any run of characters, `?` exactly one, `\` escapes a literal
 * metachar. Patterns match the FULL command text (anchored, case-sensitive).
 *
 * Entries added via the interactive "always allow" prompt option are the
 * command text with glob metachars ESCAPED — an approval covers exactly the
 * text that was approved; widening to a wildcard family is a deliberate
 * human edit of the settings file. Agents cannot write the entries
 * themselves: the settings files are enforcement-protected (see
 * enforcement.ts) — approvals flow only through the prompt.
 */

/** Glob → anchored RegExp. `*` any run, `?` one char, `\` escapes a literal, rest literal. */
export function allowlistGlobToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += escapeRegExp(pattern[++i] as string);
    } else if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else {
      re += escapeRegExp(c);
    }
  }
  // `s` flag: multi-line commands — `*` must span newlines
  return new RegExp(`^${re}$`, "s");
}

/** A shell redirection operator, joined (`2>/dev/null`, `&>f`) or bare (`2>`, `<`).
 *  Shared so parsers that walk a command's tokens strip plumbing the same way. */
export const REDIRECT_TOKEN = /^(?:[0-9]*>{1,2}|&>|[0-9]*<)/;

/** Normalize a dangerous statement for allowlist matching and storage:
 * trailing I/O redirections (`> /dev/null`, `2>&1`, `2>/dev/null`, `&>f`)
 * are plumbing, not danger — strip them so `bash x 2>&1` matches an entry
 * (or an approval) of `bash x`. Iterated because tails stack
 * (`... > /dev/null 2>&1`). User request, PR #950. */
export function normalizeDangerousStatement(stmt: string): string {
  let s = stmt.trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    // Strip only BENIGN plumbing tails (Qodo PR #950 R6): descriptor
    // duplication (`2>&1`) and /dev/null targets. A redirect to any other
    // target (file, device, $(...)) STAYS part of the statement — it is
    // side effect, not plumbing, and must not silently inherit an approval
    // granted to the un-redirected statement.
    s = s
      .replace(/\s*\d+>&\d+\s*$/, "")
      .replace(/\s*\d*(?:>{1,2}|&>)\s*\/dev\/null\s*$/, "")
      .trim();
  }
  return s;
}

/**
 * True for shell statements that read their SCRIPT from stdin — a bare
 * `bash`/`sh`/`zsh` (optionally with flags, wrappers like sudo/nohup/env,
 * and variable assignments) and no script path or -c payload. Such a
 * statement carries none of the script it will execute: `x | bash`,
 * `bash <<EOF`, `base64 -d | bash` all reduce to it. Approving it
 * persistently would approve EVERY future script fed to that shell
 * (Qodo PR #950 R6), so these statements are never allowlist-matchable
 * and never offered a persistent approval — only run-once.
 */
export function isStdinFedShellStatement(stmt: string): boolean {
  return /^(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|nohup|env|command|builtin|exec)\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)?(?:\S+\s+)?)*(?:\S*\/)?(?:ba|da|z|k|c|tc|fi)?sh(?:\s+-\w+)*\s*$/.test(
    stmt.trim(),
  );
}

/** SHA-256 of a command (or entry) — hash prefixes for logs, never the text itself. */
export function dangerousCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

// ── Session-scoped dangerous-command approvals (issue #1073) ──────────
// A middle scope between "run once" and a PERSISTED "always allow": the
// grant lasts the session and then evaporates. Memory only — never written
// to a settings file (that is what makes it safe to hand out for a need
// that lasts minutes). The store lives on globalThis keyed by Symbol.for
// so it survives `ctx.reload()`: a reload rebinds the extension instance
// while the process and the user's session stay alive.
const SESSION_GRANTS = Symbol.for("pi-config.dangerousSessionApprovals");
/** Buckets kept at once. A session that never emits `session_shutdown`
 *  (a sidecar `AgentSession.dispose()` does not) is evicted once this many
 *  newer sessions have taken grants — the store can never grow without
 *  bound in a long-lived process. */
const MAX_SESSION_BUCKETS = 64;

function sessionGrantStore(): Map<string, Set<string>> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!(g[SESSION_GRANTS] instanceof Map)) g[SESSION_GRANTS] = new Map<string, Set<string>>();
  return g[SESSION_GRANTS] as Map<string, Set<string>>;
}

/** Approve one statement for the rest of this session (memory only).
 *  A null session id stores NOTHING: an id-less bucket would be shared by
 *  every context in the process (#1073 review). */
export function grantDangerousSessionApproval(sessionId: string | null, statement: string): void {
  if (!sessionId) return;
  const store = sessionGrantStore();
  const set = store.get(sessionId) ?? new Set<string>();
  set.add(normalizeDangerousStatement(statement));
  // Re-insert so Map order stays least-recently-used-first.
  store.delete(sessionId);
  store.set(sessionId, set);
  while (store.size > MAX_SESSION_BUCKETS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    // Never silently: a user whose grant vanished gets re-prompted, and the
    // operator must be able to tell eviction from a clear (review of #1073).
    enfLog.warn("dangerous_session_grants_evicted", { bucketHash: createHash("sha256").update(oldest).digest("hex").slice(0, 12), buckets: store.size });
  }
}

/** True when this session already approved the statement. Never true for a
 *  stdin-fed shell — the same rule that keeps it out of persisted approvals
 *  (it carries none of the script it will run). */
export function hasDangerousSessionApproval(sessionId: string | null, statement: string): boolean {
  if (!sessionId || isStdinFedShellStatement(statement)) return false;
  const store = sessionGrantStore();
  const set = store.get(sessionId);
  if (set === undefined) return false;
  // Touch: an active session must not be the next bucket evicted.
  store.delete(sessionId);
  store.set(sessionId, set);
  return set.has(normalizeDangerousStatement(statement));
}

/** Drop this session's grants (session end / new / fork / resume). Called
 *  outside a reload — a reload keeps the same running session. */
export function clearDangerousSessionApprovals(sessionId: string | null): void {
  if (!sessionId) return;
  sessionGrantStore().delete(sessionId);
}

/** Test hook: wipe every session's grants. */
export function clearAllDangerousSessionApprovals(): void {
  sessionGrantStore().clear();
}

/** Approval scopes the gate OFFERS for a statement (issue #1073). Pure, so
 *  the menu, the "what this grants" text and the grant handler all derive
 *  from one tested source.
 *  - a statement that cannot be approved beyond the current run (stdin-fed
 *    shell) offers run-once and deny only;
 *  - the project scope is offered only when the project settings file is
 *    trustable to store it. */
export type DangerousApprovalScope = "once" | "session" | "project" | "everywhere" | "deny";

export function dangerousApprovalScopes(opts: {
  approvableBeyondRun: boolean;
  projectTrustable: boolean;
  sessionAvailable: boolean;
}): DangerousApprovalScope[] {
  if (!opts.approvableBeyondRun) return ["once", "deny"];
  return [
    "once",
    ...(opts.sessionAvailable ? (["session"] as const) : []),
    ...(opts.projectTrustable ? (["project"] as const) : []),
    "everywhere",
    "deny",
  ];
}

/** What each scope grants, and for how long — shown on the prompt so the
 *  user picks a scope knowing its lifetime. */
export const DANGEROUS_SCOPE_GRANTS: Record<DangerousApprovalScope, string> = {
  once: "run once — this command, now, nothing else",
  session: "this session — every later run of the SAME statement until the session ends (memory only, never written to settings)",
  project: "this project — stored in the project settings file, applies to future sessions in this folder",
  everywhere: "everywhere — stored in your global settings, applies to every future session on this machine",
  deny: "no — blocked, nothing is approved",
};

export interface DangerousAllowlistMatch {
  /** The matched settings entry (may contain wildcards). */
  entry: string;
  /** Which settings file provided it. */
  source: "project" | "global";
}

/** Matched allowlist entry for the full command text, or null.
 * Project settings take precedence over global; no env layer (deliberate:
 * ambient env must not silently approve dangerous commands).
 *
 * Security (Qodo PR #950 R3): a project settings file that is TRACKED by git
 * is not trusted for the allowlist — a cloned repo must not be able to ship
 * `{"dangerous_command_allowlist": ["*"]}` and disable the gate for everyone
 * who opens it. Only the user's own untracked project file (or the global
 * file on their machine) can approve commands. */
const trackedSettingsCache = new Map<string, ProjectSettingsTrust>();
/** Expiry for cached "tracked" verdicts (Qodo PR #950 R9): the tracked
 * verdict used to be cached forever, so a user who untracks the file
 * (`git rm --cached`) kept losing project approvals until process restart.
 * A TTL keeps the anti-clone property (a fresh process always runs the git
 * check; a clone's shipped tracked settings are rejected on first sight)
 * while honoring untracking within seconds. The unsafe direction —
 * untracked — is still NEVER cached. */
const trackedVerdictExpires = new Map<string, number>();
let trackedVerdictTtlMs = 30_000;
/** Test hook: shrink the tracked-verdict TTL so expiry is testable. */
export function setTrackedVerdictTtlForTests(ms: number): void {
  trackedVerdictTtlMs = ms;
}
/** Test hook: clear the tracked-settings cache (git state changed under us). */
export function clearTrackedSettingsCache(): void {
  trackedSettingsCache.clear();
  trackedSettingsWarned.clear();
  trackedVerdictExpires.clear();
}
const trackedSettingsWarned = new Set<string>();
/** Current trust verdict for the project settings file (public for the
 * approval writer: it must know WHERE a new entry can be stored — a
 * tracked/untrusted project file would swallow approvals that lookup
 * can never match, Qodo PR #950 R7). */
export function projectSettingsTrust(cwd: string): ProjectSettingsTrust {
  const file = getSettingsPath(cwd);
  const cached = trackedSettingsCache.get(file);
  if (cached !== undefined) {
    const expires = trackedVerdictExpires.get(file);
    if (expires === undefined || expires > Date.now()) return cached;
    // Cached tracked verdict expired — re-check (the user may have
    // untracked the file; Qodo PR #950 R9).
    trackedSettingsCache.delete(file);
    trackedVerdictExpires.delete(file);
  }
  const verdict = projectSettingsTrustUncached(cwd, file);
  // Cache the confirmed-untrusted (tracked) verdict WITH a TTL — it can
  // only become more true, but the user may legitimately untrack the file,
  // and that must recover without a process restart (R9). A trusted
  // (untracked) verdict is re-checked on EVERY use so a later `git pull` /
  // checkout that starts tracking the file is caught on the very next
  // check, not for the life of the process (Qodo PR #950 R5). An "unknown"
  // verdict (git failed transiently) is never cached — the next check
  // retries git (R7). Per-command batching (one git exec per gate
  // evaluation, not per statement) lives in loadDangerousAllowlists — the
  // per-CALL re-check semantics stay intact.
  if (verdict === "tracked") {
    trackedSettingsCache.set(file, verdict);
    trackedVerdictExpires.set(file, Date.now() + trackedVerdictTtlMs);
  }
  return verdict;
}
function projectSettingsUntracked(cwd: string): boolean {
  // Fail closed on "unknown": an unverifiable file is treated as untrusted
  // for THIS check (global entries still work); the verdict is not cached,
  // so the next check retries git.
  return projectSettingsTrust(cwd) === "untracked";
}
/** Trust verdict for a project settings file:
 * - "untracked" — CONFIRMED trustable (git exit 1, or no repo here): the
 *   file is not tracked, so it cannot have shipped with a clone.
 * - "tracked" — CONFIRMED untrusted (git listed it, or the path traverses
 *   a symlink): a cloned repo may have shipped it.
 * - "unknown" — git failed for an unrelated reason (missing binary,
 *   timeout, dubious ownership, locked index, cwd gone). Treated as
 *   untrusted for the CURRENT check but NEVER cached — the next check
 *   retries (Qodo PR #950 R7: a transient failure must not freeze the
 *   verdict for the life of the process). */
type ProjectSettingsTrust = "untracked" | "tracked" | "unknown";

function projectSettingsTrustUncached(cwd: string, file: string): ProjectSettingsTrust {
  // A settings path reached through a SYMLINK is not trustable (Qodo PR
  // #950 R6): a repo can track `.pi` as a symlink to its root and ship a
  // `*`-allowlist at the target — `git ls-files` misses the lexical path
  // while the settings loader follows the link. lstat (no follow) catches
  // both a symlinked settings file and a symlinked `.pi` dir without
  // false-positiving on symlinked session cwds (/tmp vs /private/tmp).
  // Each lstat is guarded SEPARATELY (Qodo PR #950 R9): a single try around
  // both made a MISSING settings file discard the already-read `.pi` dir
  // verdict — the first approval through a symlinked `.pi` then wrote an
  // entry the next lookup (file now existing) would reject as untrusted.
  const dirLstat = (() => { try { return lstatSync(path.dirname(file)); } catch { return null; } })();
  const fileLstat = (() => { try { return lstatSync(file); } catch { return null; } })();
  if ((dirLstat && dirLstat.isSymbolicLink()) || (fileLstat && fileLstat.isSymbolicLink())) {
    enfLog.warn("dangerous_allowlist_settings_symlink", {
      file,
      reason: "settings path traverses a symlink — not trusted for dangerous-command approvals",
    });
    return "tracked"; // structural, not transient — cacheable untrusted
  }
  // Run git from a directory that exists: `path.dirname(file)` may not
  // exist yet on a first-ever approval (Qodo PR #950 R7 — running from a
  // missing cwd threw ENOENT, which fail-closed AND cached, freezing the
  // verdict even after the approval created the file).
  let gitCwd = path.dirname(file);
  try {
    lstatSync(gitCwd);
  } catch {
    gitCwd = cwd;
  }
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--error-unmatch", file],
      { cwd: gitCwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (out) {
      if (!trackedSettingsWarned.has(file)) {
        trackedSettingsWarned.add(file);
        enfLog.warn("dangerous_allowlist_project_file_tracked", {
          file,
          reason: "tracked settings files are not trusted for dangerous-command approvals",
        });
      }
      return "tracked";
    }
    return "untracked";
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string };
    // Exit 1 = the file is genuinely not tracked — the normal, trustable case.
    if (err.status === 1) return "untracked";
    // Exit 128 + "not a git repository" = no repo here, so nothing could have
    // been cloned in — trustable. Other 128s (e.g. dubious-ownership refusal)
    // are NOT trustable: an attacker-owned checkout fails exactly like that.
    if (err.status === 128 && /not a git repository/i.test(String(err.stderr ?? ""))) return "untracked";
    // git binary missing, timeout, dubious ownership, locked index, cwd
    // gone — UNKNOWN: untrusted for this check, retried on the next one.
    enfLog.warn("dangerous_allowlist_git_check_failed", {
      file,
      status: err.status,
      fallback: "untrusted (not cached — next check retries)",
    });
    return "unknown";
  }
}

/** Allowlists loaded once per gate evaluation (Qodo PR #950 R8 perf:
 * loading per STATEMENT ran one synchronous git exec + two file reads per
 * statement — now one per command). `project` is null when the project
 * settings file is not trustable (tracked/symlinked/unverifiable). */
export interface DangerousAllowlists {
  project: string[] | null;
  global: string[];
}

/** Load both allowlist scopes for a cwd — ONE trust check + ONE read per
 * scope. Call this once per command and match statements against the
 * result via matchDangerousAllowlist. */
export function loadDangerousAllowlists(cwd: string): DangerousAllowlists {
  const project = projectSettingsUntracked(cwd)
    ? (loadProjectSettings(cwd).dangerous_command_allowlist ?? [])
    : null;
  const global = loadGlobalSettings().dangerous_command_allowlist ?? [];
  return { project, global };
}

/** Match one normalized statement against pre-loaded allowlists (no git,
 * no file I/O — safe to call per statement). */
export function matchDangerousAllowlist(lists: DangerousAllowlists, command: string): DangerousAllowlistMatch | null {
  // Defense in depth (Qodo PR #950 R6): a stdin-fed shell statement (`bash`,
  // `sh -s`, ...) executes whatever script is fed to it — even a hand-added
  // settings entry can never approve it. The gate already refuses to offer
  // persistent approval for such statements.
  if (isStdinFedShellStatement(command)) return null;
  if (lists.project) {
    const p = lists.project.find((e) => allowlistGlobToRegExp(e).test(command));
    if (p) return { entry: p, source: "project" };
  }
  const g = lists.global.find((e) => allowlistGlobToRegExp(e).test(command));
  return g ? { entry: g, source: "global" } : null;
}

export function findDangerousAllowlistEntry(cwd: string, command: string): DangerousAllowlistMatch | null {
  // Per-CALL semantics (unchanged since R5): every call re-checks trust, so
  // a `git pull` that starts tracking the project file is caught on the
  // very next call. The gate uses the batched loadDangerousAllowlists path
  // for per-command efficiency; direct callers keep the strict behavior.
  return matchDangerousAllowlist(loadDangerousAllowlists(cwd), command);
}

/** Result of persisting a dangerous-command approval. `scope` is where the
 * entry ACTUALLY landed — the caller logs/notifies it, and "global" means
 * the project file was CONFIRMED untrustworthy (git-tracked or symlinked)
 * so the approval was stored in the user's global settings instead, where
 * lookup will honor it (Qodo PR #950 R7/R8). A `trust_unknown` failure is
 * deliberately NOT persisted anywhere: a transient git failure in one
 * project must not mint a machine-wide approval (R8) — the approval is
 * one-time and the user can retry once git answers. */
export type DangerousAllowlistWriteResult =
  | { ok: true; scope: "project" | "global"; file: string }
  | { ok: false; reason: "corrupt" | "write_failed" | "trust_unknown" | "project_untrusted"; file: string };

/** Append the exact command text (glob metachars escaped, so the entry stays
 * literal) to the settings file. Fail-soft (returns a result, never throws).
 * A mkdir-based lock serializes writers so concurrent approvals cannot drop
 * each other (read-merge-write race).
 *
 * Scope is EXPLICIT (user request, PR #950 R8): the prompt offers "this
 * project" and "everywhere" as distinct choices. `scope: "project"` writes
 * the project file and FAILS when it is not trustable (git-tracked or
 * symlinked — the caller must not have offered the option, but fail safe
 * anyway). `scope: "global"` writes the user's machine-wide file — the
 * caller only offers it as an explicit choice, never a silent fallback.
 * When trust is UNKNOWN (git failed transiently) a project write is
 * refused: run-once only (R8) — a transient failure must not mint a
 * machine-wide approval either. */
export function addDangerousAllowlistEntry(
  cwd: string,
  command: string,
  scope: "project" | "global" = "project",
): DangerousAllowlistWriteResult {
  const trust = projectSettingsTrust(cwd);
  if (scope === "project") {
    if (trust === "tracked") {
      // The option should not have been offered — refuse the write rather
      // than silently redirecting scope (fail safe, no silent fallback).
      enfLog.warn("dangerous_allowlist_project_untrusted_refused", {
        trust,
        reason: "project settings file is not trustable — project-scope approval refused",
      });
      return { ok: false, reason: "project_untrusted", file: getSettingsPath(cwd) };
    }
    if (trust === "unknown") {
      // Never persist on an unverifiable state (Qodo PR #950 R8): fail the
      // write; the gate tells the user this approval is one-time until git
      // can verify the project file.
      enfLog.warn("dangerous_allowlist_trust_unknown", {
        reason: "project settings trust could not be verified (git check failed) — approval is one-time",
      });
      return { ok: false, reason: "trust_unknown", file: getSettingsPath(cwd) };
    }
  }
  const file = scope === "project" ? getSettingsPath(cwd) : getGlobalSettingsPath();
  const entry = command.replace(/[\\*?]/g, (c) => `\\${c}`);
  try {
    // The settings dir may not exist yet on a first-ever write
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withSettingsFileLock(file, () => {
      const data = readSettingsFile(file);
      if (data === null) {
        // Corrupt/unparseable settings file — NEVER overwrite it with just the
        // new entry: earlier approvals and every other setting would be lost
        // (Qodo PR #950 R2). Bail fail-soft and let the user repair the file.
        enfLog.warn("dangerous_allowlist_settings_unreadable", {
          file,
          hashPrefix: dangerousCommandHash(command).slice(0, 12),
        });
        return { ok: false, reason: "corrupt", file } as const;
      }
      const list = Array.isArray(data.dangerous_command_allowlist)
        ? data.dangerous_command_allowlist.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [];
      if (!list.includes(entry)) list.push(entry);
      data.dangerous_command_allowlist = list;
      writeSettingsFile(file, data, { lockHeld: true });
      return { ok: true, scope, file } as const;
    });
  } catch (error: any) {
    // Hash prefix + path identify the affected approval without copying
    // command text into global logs (Qodo PR #950).
    enfLog.warn("dangerous_allowlist_write_failed", {
      reason: String(error?.message ?? error).slice(0, 200),
      hashPrefix: dangerousCommandHash(command).slice(0, 12),
      file,
    });
    return { ok: false, reason: "write_failed", file };
  }
}

/**
 * Check if a statement is a read-only command with no dangerous subshells.
 * Returns true if the DANGEROUS check should be skipped for this statement.
 */
export function isReadOnlyStatement(stmt: string): boolean {
  // Strip transparent wrapper prefixes (rtk/env/timeout/nice/nohup/command/
  // builtin/exec) and VAR=value assignments so `rtk grep` gets the same
  // read-only pass as `grep` (issue #947).
  const stripped = stmt.replace(READ_ONLY_WRAPPER_PREFIX_RE, "");
  const baseCmd = stripped.split(/\s/)[0]?.replace(/^.*\//, ""); // strip path prefix
  if (!baseCmd || !READ_ONLY_COMMANDS.has(baseCmd)) return false;

  // Check subshells for dangerous content
  const subshells = extractSubshells(stmt);
  // Evaluate extracted content against DANGEROUS as raw strings — catches nested subshells too
  return !subshells.some((sub) => DANGEROUS.some((p) => p.test(sub)));
}

/** Pattern matching direct recursive rm commands (subset of DANGEROUS patterns). */
const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i;

/** Tokenize the target paths of an rm command found in `stmt` (flags, the
 *  `--` separator, and shell redirections skipped; surrounding quotes
 *  stripped). Returns null when no rm token is present. Shared by
 *  isRmInProjectTmp and relativeRecursiveRmTarget (issue #963). */
interface RmPathToken {
  value: string;
  /** Quote character that surrounded the token, if any. SINGLE quotes make
   *  the content fully literal; DOUBLE quotes still expand $VAR and
   *  backticks while suppressing tilde expansion and globbing (Qodo PR
   *  #964 round 3 — a boolean quoted flag conflated the two). */
  quote: "'" | '"' | null;
}

/** Whitespace tokenizer that keeps quoted spans together: `rm -rf "/abs/My
 *  Dir"` is ONE path token, not the fragments `"/abs/My` and `Dir"` (Qodo
 *  PR #964 round 3). A quote character always starts a new token —
 *  mid-token quotes (`--flag="x"`) split, which is conservative for rm
 *  argument parsing. */
function splitRmTokens(stmt: string): RmPathToken[] {
  const out: RmPathToken[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = (q: "'" | '"' | null) => {
    if (cur) out.push({ value: cur, quote: q });
    cur = "";
  };
  for (const ch of stmt.trim()) {
    if (quote) {
      if (ch === quote) {
        push(quote);
        quote = null;
      } else cur += ch;
    } else if (ch === '"' || ch === "'") {
      push(null);
      quote = ch;
    } else if (/\s/.test(ch)) {
      push(null);
    } else cur += ch;
  }
  push(quote); // unterminated quote — keep the residue as its own token
  return out;
}

function parseRmPathTokens(stmt: string): RmPathToken[] | null {
  const paths: RmPathToken[] = [];
  let pastSeparator = false;
  let pastRm = false;
  let skipNext = false;

  for (const token of splitRmTokens(stmt)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!pastRm) {
      if (token.value === "rm" || token.value.endsWith("/rm")) pastRm = true;
      continue;
    }
    if (token.value === "--" && token.quote === null) {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator && token.value.startsWith("-") && token.quote === null) continue;
    // Skip shell redirections — handle both joined (2>/dev/null) and spaced (2> /dev/null)
    if (REDIRECT_TOKEN.test(token.value)) {
      // If the token is ONLY the operator (no target attached), skip the next token too
      if (/^(?:[0-9]*>{1,2}|&>|[0-9]*<)$/.test(token.value)) {
        skipNext = true;
      }
      continue;
    }
    paths.push(token);
  }

  return pastRm ? paths : null;
}

/** Leading wrapper prefixes that may precede a direct `rm` invocation
 *  (issue #963). Same family as the bare-shell wrapper alternation in the
 *  DANGEROUS patterns, but INCLUDES sudo: the absolute-path requirement
 *  applies to `sudo rm -rf rel` just as much as to bare `rm -rf rel`. */
// The `--` end-of-options marker is its own alternative that consumes NO
// value: the old `-.S+` matched `--` and then its optional value slot ate
// the command itself (`env -- rm -rf x` left `-rf x` with no command token,
// evading the gate — Qodo PR #964).
const RM_LEADING_WRAPPERS_RE =
  /^\s*(?:\S+=\S*\s+|sudo(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?))*\s+|rtk(?:\s+(?:--\S+|-(?!-)\S+))*\s+|(?:command|builtin|exec)\s+|env(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?|\S+=\S*))*\s+|timeout\s+(?:(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?)\s+)*\S+\s+|nice(?:\s+(?:--\S+|--|-(?!-)\S+(?:\s+\S+)?))*\s+|nohup\s+)+/;

/**
 * First non-absolute target of a direct (optionally wrapped) recursive rm
 * statement, or null (issue #963). "Absolute" = starts with `/` or `~`.
 *
 * find -exec / xargs rm variants return null — their targets come from find
 * output / stdin, not statement text. Recursive rm with a relative target
 * must be blocked: a persistent "always allow" approval stores the
 * statement text, so a relative target would approve the identical text in
 * ANY directory; an absolute path binds the approval to exactly one folder.
 */
export function relativeRecursiveRmTarget(stmt: string): string | null {
  if (!RM_PATTERN.test(stmt)) return null;
  // rm must be the COMMAND, not a word inside another command (Qodo PR
  // #964): `git rm -r --cached build` and `git commit -m "chore: rm -rf
  // build dir"` previously matched because the tokenizer scanned for `rm`
  // anywhere — hard-blocking git subcommands and commit messages that the
  // dangerous-prompt path already handles.
  const stripped = stmt.replace(/^\(\s*/, "").replace(RM_LEADING_WRAPPERS_RE, "");
  const firstWord = stripped.trim().split(/\s+/)[0];
  if (firstWord !== "rm" && !firstWord?.endsWith("/rm")) return null;
  // find -exec rm / xargs rm carry their targets from find output / stdin.
  // COMMAND-POSITION only: `rm -rf find` (a directory named find) must stay
  // blocked (Qodo PR #964) — the old word-boundary test exempted it.
  if (firstWord === "find" || /(?:^|\|\s*)xargs\s+rm\b/.test(stmt) || /\bfind\b[^|;]*-exec\b/.test(stmt)) {
    return null;
  }
  const paths = parseRmPathTokens(stripped);
  if (!paths || paths.length === 0) return null;
  for (const p of paths) {
    const t = p.value;
    // Project temp dir by variable: deterministic per-cwd, expanded and
    // validated by isRmInProjectTmp downstream (Qodo PR #964 — the gate
    // must not block the documented ${PROJECT_TMP_DIR} cleanup pattern).
    // ANCHORED (Qodo PR #964 round 3): the variable must END here or be
    // followed by / — a prefix match let $PROJECT_TMP_DIR_BACKUP skip the
    // gate. The variable expands unquoted AND inside double quotes.
    const projTmpVar = /^\$\{PROJECT_TMP_DIR\}(?:$|\/)|^\$PROJECT_TMP_DIR(?![\w$])(?:$|\/)/.test(t);
    // Traversal and non-literal suffixes drop the exemption (Qodo PR #964
    // rounds 4-5): a legit temp path never needs ".." (the variable already
    // points at the tmp root), and its suffix must be LITERAL —
    // "${PROJECT_TMP_DIR}/$TARGET" with TARGET=../../important expanded
    // past both the gate and the tmp check while still looking exempt.
    const suffix = t
      .replace(/^\$\{PROJECT_TMP_DIR\}/, "")
      .replace(/^\$PROJECT_TMP_DIR(?![\w$])/, "");
    const suffixLiteral = !/[$`*?[\]]/.test(suffix) && !t.includes("..");
    if (projTmpVar && p.quote !== "'" && suffixLiteral) continue;
    if (p.quote === "'") {
      // Single quotes: fully literal. A quoted tilde does NOT expand (it
      // is a relative path), and $/glob chars are inert — only a quoted
      // absolute path binds to one folder.
      if (t.startsWith("/")) continue;
      return t;
    }
    if (p.quote === '"') {
      // Double quotes: tilde does NOT expand (relative → block), but $VAR
      // and backticks DO — an approval for "/home/$USER/build" must not
      // bind. Globs are inert inside quotes, so only / $ ` matter.
      if (t.startsWith("~")) return t;
      if (/[$`]/.test(t)) return t;
      if (t.startsWith("/")) continue;
      return t;
    }
    // Unquoted: tilde expands to $HOME (absolute); any expansion or glob
    // char makes the target non-literal — an approval for
    // /home/$USER/build or /home/*/build must not bind to varying
    // directories (Qodo PR #964).
    if (t.startsWith("~")) continue;
    if (/[$`*?[\]]/.test(t)) return t;
    if (t.startsWith("/")) continue;
    return t;
  }
  return null;
}

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

  // Parse arguments: flags, -- separator, redirections (shared tokenizer)
  const tokens = parseRmPathTokens(stmt);

  // Guard against vacuous truth — if no paths extracted, don't silently allow
  if (!tokens || tokens.length === 0) return false;
  const paths = tokens.map((t) => t.value);

  // Resolve and substitute PROJECT_TMP_DIR env var
  const projectTmpDir = path.join(cwd, ".pi", "tmp");
  // The home scratch (~/.pi/tmp) is our own throwaway tree too: the logger fallback and build
  // scratch tests write there. Same exemption as the project one, same literal-path guards.
  // Two roots, and BOTH must match: the scratch path as written (which may itself be a symlink —
  // `~/.pi/tmp` often points into a dotfiles checkout) and where that path really lives. Matching
  // only the real root made a symlink's target trusted: with `~/.pi/tmp -> ~`, `rm -rf ~/.ssh`
  // resolves beneath it and would skip approval without ever naming the scratch.
  // Both resolutions live inside one try: `homedir()` itself can throw when HOME is unset or
  // points nowhere, and this helper feeds the dangerous-command gate — an exception here would
  // replace a decision with a crash instead of simply granting no exemption.
  let lexicalHomeTmp: string | null = null;
  let resolvedHomeTmp: string | null = null;
  try {
    lexicalHomeTmp = path.resolve(realpathSync(homedir()), ".pi", "tmp").replace(/\/+$/, "");
    resolvedHomeTmp = realpathSync(lexicalHomeTmp);
  } catch {
    lexicalHomeTmp = null; // no home, or no scratch in it — nothing to match
    resolvedHomeTmp = null;
  }
  const underHomeTmp = (pathname: string, root: string): boolean =>
    pathname === root || pathname.startsWith(root + path.sep);
  let resolvedCwd: string | null;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = null; // cwd doesn't exist — project tmp checks will all fail
  }

  for (const p of paths) {
    // Substitute ${PROJECT_TMP_DIR} or $PROJECT_TMP_DIR
    const expanded = p.replace(/\$\{?PROJECT_TMP_DIR\}?/g, projectTmpDir);
    // Refuse `..` outright. `path.resolve` collapses it LEXICALLY, while the kernel applies it to
    // where a preceding symlink actually points — so `~/.pi/tmp/link/../.ssh/key` looks in-scratch
    // here and deletes `~/.ssh/key` there. Nothing legitimate needs `..` in a scratch operand.
    if (/(^|\/)\.\.($|\/)/.test(expanded)) return false;
    // The shell removes backslashes before `rm` sees the path, so `\.\.` is `..` and `\*` is a
    // glob that no literal-path check ever saw. A literal scratch path needs none of them.
    if (expanded.includes("\\")) return false;
    const lexical = path.resolve(cwd, expanded);
    let resolved: string;
    try {
      // Use realpathSync to resolve symlinks — prevents symlink traversal attacks
      resolved = realpathSync(lexical);
    } catch {
      // Path doesn't exist. For /tmp paths, validate the existing parent via realpathSync
      // to catch symlinked parents (e.g., /tmp/evil-link -> / where evil-link exists).
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
      } else if (resolvedHomeTmp !== null && lexicalHomeTmp !== null && underHomeTmp(lexical, lexicalHomeTmp)) {
        // Non-existent path under the home scratch — validate the parent the same way.
        if (expanded.includes("..")) return false;
        const parentDir = path.dirname(lexical);
        try {
          const resolvedParent = realpathSync(parentDir);
          if (!resolvedParent.startsWith(resolvedHomeTmp + path.sep) && resolvedParent !== resolvedHomeTmp) {
            return false;
          }
        } catch {
          // Parent also doesn't exist — safe
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

    // The path as WRITTEN must name the scratch (a symlinked scratch cannot lend its target out),
    // and its real location must stay inside the scratch (a symlink inside it cannot escape).
    const inHomeTmp = lexicalHomeTmp !== null && resolvedHomeTmp !== null &&
      underHomeTmp(lexical, lexicalHomeTmp) && underHomeTmp(resolved, resolvedHomeTmp);

    if (!inProjectTmp && !inSystemTmp && !inHomeTmp) return false;
  }

  return true;
}

/**
 * ── Real git-invocation detection (single source of truth) ─────────────────
 *
 * Shared by isRealGitCommitOrPush (git-expert-only guard), injectSignoff (DCO),
 * and checkGitProtection's sub-detection in enforcement.ts. The constructions
 * must never drift: a divergence is either a guard bypass or a corrupted
 * injection.
 *
 * Wrapper prefixes: sudo/env (incl. argument-taking flags), VAR=value
 * assignments, command/builtin/exec — AND rtk. The user-level rtk extension
 * rewrites every bash command through `rtk rewrite` BEFORE enforcement
 * evaluates it (`git commit -m x` arrives as `rtk git commit -m x`), so
 * without the rtk alternative every wrapped invocation is invisible to the
 * guards (live incident: the git-expert-only commit guard never fired on a
 * direct orchestrator commit). Boundary includes backtick because unescaped
 * backticks are command substitution and DO execute git.
 *
 * Qodo #8 (PR #916): boundaries also cover shell condition keywords
 * (if/while/until/!), negation, and exec-wrappers that take arguments
 * (timeout/nice/nohup/xargs/time), and an opening quote after `bash -c` /
 * `sh -c` / `eval` opens a nested command position — `timeout 60 git push`,
 * `if git commit ...`, `time git commit`, and `bash -c "git commit"` are all
 * real invocations the old boundary set missed.
 *
 * Qodo round 2 (PR #916): the shell alternative accepts ANY c-containing
 * short-flag cluster (`bash -lc`, `sh -ec`, `bash -xc`) plus long flags
 * (`bash --login -c`); and quoted PROSE is masked before matching
 * (maskQuotedProse) so `!`/`if`/`while` inside a `-m` message or an echoed
 * string can never look like a command boundary.
 */
const GIT_BOUNDARY_SRC =
  /(?:^|[;&|\n(){`]|!|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b|\bif\b|\bwhile\b|\buntil\b|(?:\b(?:bash|sh|zsh|dash|ksh)\s+(?:-{1,2}[a-zA-Z][a-zA-Z-]*\s+)*-[a-zA-Z]*c[a-zA-Z]*\s*|\beval\s*)(?:["'`]\s*)?)\s*/.source;
const GIT_WRAPPER_SRC = /(?:sudo|env|timeout|nice|nohup|xargs|time)(?:\s+(?!git\b)\S+)*\s+/.source;
const GIT_ASSIGN_SRC = /[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.source;
const GIT_WRAP_SRC = /(?:command|builtin|exec)\s+/.source;
const GIT_RTK_SRC = /rtk(?:\s+-\S+)*\s+/.source;
const GIT_PREFIX_SRC = `(?:${GIT_WRAPPER_SRC}|${GIT_ASSIGN_SRC}|${GIT_WRAP_SRC}|${GIT_RTK_SRC})*`;
const GIT_EXE_SRC = /(?:\S*\/)?git\b/.source;
// Global options may precede the subcommand (`git -C <path> commit`). Short options
// take a separate value; so do the long ones git accepts with a space
// (`--git-dir <p>`) — listing only those keeps `--no-pager commit` from being read
// as "long option plus its value".
const GIT_FLAGS_SRC =
  /(?:\s+(?:-[a-zA-Z]\s+\S*|--(?:git-dir|work-tree|namespace|config-env)\s+\S*|-\S+))*/.source;

/** Prefix that opens a nested command string: `bash -lc "..."`, `sh -c '...'`, `eval "..."`. */
const SHELL_C_PREFIX_RE =
  /(?:\b(?:bash|sh|zsh|dash|ksh)\s+(?:-{1,2}[a-zA-Z][a-zA-Z-]*\s+)*-[a-zA-Z]*c[a-zA-Z]*|\beval)\s*$/;

/**
 * Mask quoted PROSE so it can never look like a command boundary (Qodo
 * rounds 2–4, PR #916). A scanner implementing SHELL quote semantics, not a
 * plain regex and not heuristics:
 * - a BACKSLASH outside quotes escapes the next character, so `\"` is a
 *   literal and `echo \"; git push; echo \"x\"` still executes git push;
 * - an apostrophe ALWAYS opens a single-quote string outside double quotes
 *   (shell grammar has no contractions — `foo' ; git push main'`
 *   concatenates `foo` with the QUOTED text ` ; git push main`, so the
 *   quoted part is prose, never code). An apostrophe inside a `#` comment
 *   is irrelevant because comment tails are blanked first;
 * - a `#` at a word start begins a comment — blanked to end of line so its
 *   quotes cannot pair with code;
 * - inside a quoted span only COMMAND SUBSTITUTION (`$(...)`, backticks)
 *   executes, so a span is blanked EXCEPT its substitution regions —
 *   `echo "if git commit fails $(date)"` keeps only `$(date)` visible;
 * - a span that directly follows `bash -c`/`sh -c`/`eval` is a nested
 *   command string and stays fully visible;
 * - an UNTERMINATED span is a shell syntax error — nothing executes — so it
 *   is blanked entirely.
 * The result is LENGTH-PRESERVING so match indices on the masked text are
 * valid on the original string.
 */
function maskQuotedProse(command: string): string {
  const out = command.split("");
  let maskedSpans = 0;
  /** Sentinel written in place of a substitution's CLOSING delimiter (`)` or
   *  backtick) in the masked output. It lets consumers distinguish the
   *  delimiter from a quoted `)` inside the substitution's content — both are
   * restored verbatim, but only the delimiter becomes SENTINEL (Qodo round
   *  8, PR #916). NUL cannot occur in a real command string. */
  const SUBST_CLOSE_SENTINEL = "\x00";
  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = " ";
  };
  /** Blank [from, to) except its $(...) and backtick substitution regions,
   *  which are restored verbatim from the original command. The close-paren
   *  scan is QUOTE-AWARE (Qodo round 5, PR #916): a `)` inside a quoted
   *  argument of the substitution (`$(printf ')'; git push main)`) does not
   *  close it — only an unquoted, unescaped paren changes depth. The closing
   *  delimiter itself is restored as SUBST_CLOSE_SENTINEL so downstream
   *  parsers can tell it apart from content parens (Qodo round 8). */
  const blankExceptSubstitutions = (from: number, to: number): void => {
    blankRange(from, to);
    let k = from;
    while (k < to) {
      const c = command[k]!;
      if (c === "$" && command[k + 1] === "(") {
        const closers: number[] = [];
        const close = scanBalancedParen(command, k + 1, {
          end: to,
          unquotedEscapes: true,
          onCloseParen: (p) => closers.push(p),
        });
        const stop = close !== null ? close + 1 : to;
        for (let x = k; x < stop; x++) out[x] = command[x]!;
        for (const p of closers) {
          if (p < stop) out[p] = SUBST_CLOSE_SENTINEL;
        }
        k = stop;
        continue;
      }
      if (c === "`") {
        let m = k + 1;
        while (m < to && command[m] !== "`") m++;
        const stop = m < to ? m + 1 : to;
        for (let x = k; x < stop; x++) out[x] = command[x]!;
        if (m < to) out[stop - 1] = SUBST_CLOSE_SENTINEL;
        k = stop;
        continue;
      }
      k++;
    }
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    // Comment tail: `#` at a word start (${...} and =# forms excluded) is a
    // comment — blank to end of line, quotes inside cannot pair with code.
    if (ch === "#" && (i === 0 || /[\s(;&|`]/.test(command[i - 1]!))) {
      const j = skipLineComment(command, i);
      blankRange(i, j);
      maskedSpans++;
      i = j;
      continue;
    }
    // A backslash outside quotes escapes the next char — it can never open
    // a span (handles \\" and \\').
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        const c = command[j]!;
        // Inside double quotes a backslash escapes the next char (\" and \\).
        // Inside single quotes a backslash is literal; only ' terminates.
        if (quote === '"' && c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        j++;
      }
      const end = closed ? j + 1 : command.length;
      if (closed && SHELL_C_PREFIX_RE.test(command.slice(0, i))) {
        // Nested command string — keep fully visible for the boundary regex.
      } else {
        // Prose span (or unterminated = syntax error, nothing executes):
        // blank it except command substitutions, which still execute.
        blankExceptSubstitutions(i, end);
        maskedSpans++;
      }
      i = end;
      continue;
    }
    i++;
  }
  if (maskedSpans > 0) enfLog.debug("maskQuotedProse", "masked", maskedSpans, "chars", command.length);
  return out.join("");
}

const realGitSubRegexCache = new Map<string, RegExp>();
const subScanReCache = new Map<string, RegExp>();
let lastStrippedAndMasked: { command: string; stripped: string; masked: string } | null = null;

function getStrippedAndMasked(command: string): { stripped: string; masked: string } {
  if (lastStrippedAndMasked && lastStrippedAndMasked.command === command) {
    return lastStrippedAndMasked;
  }
  const stripped = stripHeredocBodies(command);
  const masked = maskQuotedProse(stripped);
  lastStrippedAndMasked = { command, stripped, masked };
  return lastStrippedAndMasked;
}

/** Regex matching a REAL `git <sub>` invocation at a shell command position. */
export function realGitSubRegex(sub: string, capture = false): RegExp {
  const key = `${sub}\0${capture ? "1" : "0"}`;
  const cached = realGitSubRegexCache.get(key);
  if (cached) return cached;
  const body = `${GIT_BOUNDARY_SRC}${GIT_PREFIX_SRC}${GIT_EXE_SRC}${GIT_FLAGS_SRC}\\s+${sub}\\b`;
  const re = new RegExp(capture ? `(${body})` : body);
  if (realGitSubRegexCache.size >= 32) {
    const oldest = realGitSubRegexCache.keys().next().value;
    if (oldest !== undefined) realGitSubRegexCache.delete(oldest);
  }
  realGitSubRegexCache.set(key, re);
  enfLog.debug("realGitSubRegex built", sub, `capture=${capture}`);
  return re;
}

function getSubScanRegex(sub: string): RegExp {
  const cached = subScanReCache.get(sub);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  const re = new RegExp(
    `${GIT_BOUNDARY_SRC}${GIT_PREFIX_SRC}${GIT_EXE_SRC}${GIT_FLAGS_SRC}\\s+${sub}\\b`,
    "g",
  );
  if (subScanReCache.size >= 32) {
    const oldest = subScanReCache.keys().next().value;
    if (oldest !== undefined) subScanReCache.delete(oldest);
  }
  subScanReCache.set(sub, re);
  return re;
}

/**
 * True when the command really invokes `git <sub>` — command position only,
 * any wrapper prefix (sudo/env/assignments/command/builtin/exec/rtk),
 * heredoc bodies stripped. Replaces the old loose matcher, which matched
 * `git ... <sub>` ANYWHERE, false-positiving on sub-command names inside -m
 * messages ("git commit -m 'add sites'" tripped the git-add checks) and in
 * other statements of a compound command ("git log | grep checkout" tripped
 * the use_worktrees checkout block).
 */
export function realGitSub(command: string, sub: string): boolean {
  const result = realGitSubRegex(sub).test(getStrippedAndMasked(command).masked);
  enfLog.debug("realGitSub", sub, result);
  return result;
}

/**
 * Argument regions of every real `git <sub>` invocation: the statement-scoped
 * text after the subcommand, up to the next ; & | or newline — so arguments
 * of OTHER statements in a compound command are never included
 * ("git add f.ts && bash scripts/x.sh" must not treat scripts/x.sh as staged).
 * Regions are raw (quotes intact); consumers inspecting FLAGS must strip
 * quoted spans first (a -m message is not an argument list).
 */
export function gitSubArgRegions(command: string, sub: string): string[] {
  // Boundaries are matched on PROSE-MASKED text (a quoted "Done! git push"
  // must not look like a command position), but the region CONTENT comes
  // from the original string — masking is length-preserving, so match
  // indices on the masked text are valid on the original, and quoted VALUES
  // (pathspecs, "main" refspecs) stay intact for consumers (Qodo round 2,
  // PR #916).
  return subArgSpans(command, sub).map((s) => s.text);
}

/** Argument-region spans of every real `git <sub>` invocation, with start/end
 *  offsets into the heredoc-stripped command and the aligned masked text —
 *  consumers that must distinguish substitution syntax from refspec content
 *  use the masked slice (Qodo round 6, PR #916). */
function subArgSpans(command: string, sub: string): Array<{ start: number; end: number; text: string; maskedText: string; stripped: string; masked: string }> {
  const { stripped, masked } = getStrippedAndMasked(command);
  const re = getSubScanRegex(sub);
  const spans: Array<{ start: number; end: number; text: string; maskedText: string; stripped: string; masked: string }> = [];
  for (const m of masked.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    // Boundaries are searched on the MASKED text, so a separator inside a quoted
    // argument is prose, not the end of the invocation: in
    // `git commit -m "message; more message" --author='A <a@b>'` the author
    // option belongs to this commit and must stay inside its region (Qodo, PR
    // #996). Masking is length-preserving, so the offset is valid on the
    // original string and the region content still comes from it.
    const end = masked.slice(start).search(/[;&|\n]/);
    const stop = end === -1 ? stripped.length : start + end;
    spans.push({
      start,
      end: stop,
      text: stripped.slice(start, stop),
      maskedText: masked.slice(start, stop),
      stripped,
      masked,
    });
  }
  enfLog.debug("gitSubArgRegions", sub, `regions=${spans.length}`);
  return spans;
}

/** Remove quoted spans so message CONTENT never looks like arguments. */
export function stripQuotedSpans(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
}

/** Tokenize a git-add argument region: quote-aware tokens, redirects dropped. */
function gitAddTokens(region: string): string[] {
  // Empty tokens (an unterminated residual quote yields one) carry no
  // pathspec and must not reach consumers (Qodo live battery, PR #916).
  return tokenize(region).filter((t) => t && !/[<>]/.test(t));
}

/** Argument regions of every real `git <sub>` invocation with
 *  command-substitution CLOSING delimiters neutralized (Qodo rounds 6+8,
 *  PR #916): parses the ORIGINAL text (quoted values survive) but blanks
 *  every character the masked text replaced with the substitution-close
 *  sentinel — the `)`/backtick that ENDS a `$(...)`. A `)` inside the
 *  substitution's quoted content (a legal branch-name character, e.g.
 *  `$(git push origin 'foo)')`) is restored verbatim in the masked text
 *  and therefore STAYS, so the ref `foo)` is compared exactly; a `)` in a
 *  top-level quoted span (prose-blanked in the masked text) also stays.
 *  Consumers that TOKENIZE arguments use this instead of
 *  gitSubArgRegions, so a bulk `git add .` inside `$(...)` is not read as
 *  the pathspec `.)` while a quoted `foo)` ref is not truncated. */
export function gitSubParseRegions(command: string, sub: string): string[] {
  return subArgSpans(command, sub).map((s) => {
    if (!s.maskedText.includes("\x00")) return s.text;
    let out = "";
    for (let idx = 0; idx < s.text.length; idx++) {
      out += s.maskedText[idx] === "\x00" ? " " : s.text[idx];
    }
    return out;
  });
}

/** Destination refs of every real `git push` invocation (Qodo #5, PR #916).
 *  Quote-aware tokenization (a quoted "main" is still a refspec), flags and
 *  remote URLs skipped, and each refspec reduced to its DESTINATION side —
 *  `HEAD:main`, `feature:main`, `+main`, `refs/heads/main`, and plain `main`
 *  all yield `main`. Returns the first ref that names a protected branch
 *  (full or suffix match), or null when no push target is protected. */
export function pushTargetsProtectedBranch(command: string, protectedBranches: Iterable<string>): string | null {
  const pbSet = new Set(protectedBranches);
  for (const parseRegion of gitSubParseRegions(command, "push")) {
    // Quoted refspec values ("main", 'release)') survive because the region
    // comes from the ORIGINAL text; live substitution `)`s are already
    // neutralized by gitSubParseRegions (Qodo rounds 5-6, PR #916).
    let pastSep = false;
    for (const token of tokenize(parseRegion)) {
      if (token === "--") {
        pastSep = true;
        continue;
      }
      if (!pastSep && token.startsWith("-")) continue; // flag
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue; // remote URL (https://, ssh://)
      // Forced-push leading + is part of the refspec syntax, not the ref.
      const spec = token.startsWith("+") ? token.slice(1) : token;
      const colon = spec.lastIndexOf(":");
      const raw = (colon >= 0 ? spec.slice(colon + 1) : spec).trim();
      if (!raw) continue;
      const dest = raw.replace(/^refs\/heads\//, "");
      if (pbSet.has(dest)) {
        enfLog.debug("pushTargetsProtectedBranch", `protected=${dest}`);
        return dest;
      }
    }
  }
  return null;
}

/**
 * Pathspec tokens of every real `git add` invocation — quote-aware (a quoted
 * path with spaces is one token), flags and redirects excluded, everything
 * after `--` included. Empty when the command stages nothing; null when it
 * invokes no real `git add` at all. Consumers: the gitignore staging guard.
 */
export function gitAddPathspecs(command: string): string[] | null {
  const regions = gitSubParseRegions(command, "add");
  if (regions.length === 0) return null;
  const paths: string[] = [];
  for (const region of regions) {
    let pastSeparator = false;
    for (const token of gitAddTokens(region)) {
      if (token === "--") {
        pastSeparator = true;
        continue;
      }
      if (!pastSeparator && token.startsWith("-")) continue; // flag
      paths.push(token);
    }
  }
  enfLog.debug("gitAddPathspecs", `paths=${paths.length}`);
  return paths;
}

export type CommitMessageSpec =
  | { kind: "file"; path: string; rawOperand: string; cwd: string }
  | { kind: "opaque-file"; raw: string }
  | { kind: "inline" };

/**
 * Classify EVERY real `git commit` in the command into its message source:
 * - `{ kind: "file", path, rawOperand, cwd }` for a resolved `-F`/`--file` path
 * - `{ kind: "opaque-file", raw }` when `-F`/`--file` was given (and not `-`),
 *   but the operand (or a relative operand's directory wrapper) is unresolvable
 *   (line continuation, `$VAR`, backtick, glob, `~`, redirect, or missing operand)
 *   — must block directly, never fall back
 * - `{ kind: "inline" }` for stdin (`-F -`, `--file=-`), `-m`, or no `-F`
 */
export function commitMessageSpecs(command: string, sessionCwd: string): CommitMessageSpec[] {
  const specs: CommitMessageSpec[] = subArgSpans(command, "commit").map((span) => {
    const words = rawShellWords(span.text);
    // git records the LAST `-F` of an invocation, so the earlier ones are not
    // files it opens: keep scanning instead of returning the first (#1131).
    let sawFileFlag = false;
    let operand: string | null = null;
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (word.startsWith("#")) break; // shell comment runs to end of line
      if (word === "--") break; // after this, paths only
      if (word === "--file") {
        sawFileFlag = true;
        const next = words[i + 1];
        if (next && !next.startsWith("#")) {
          operand = next;
          i++;
        } else {
          enfLog.debug("commitMessageSpecs missing operand", word);
          operand = null;
        }
      } else if (word.startsWith("--file=")) {
        sawFileFlag = true;
        operand = word.slice("--file=".length);
      // An inline message wins: `git commit --message='--file=good.txt'` records
      // that literal text, so its operand is a MESSAGE and the commit is opaque
      // (Qodo, PR #1139).
      } else if (/^--message(?:=|$)/.test(tokenize(word)[0] ?? "")) {
        enfLog.debug("commitMessageSpecs inline message wins", word);
        sawFileFlag = false;
        operand = null;
        break;
      } else if (word.startsWith("-") && !word.startsWith("--") && word.length > 1) {
        // Scan single-dash short option cluster left-to-right so `-aFmsg.txt`,
        // `-aF msg.txt`, `-sFmsg.txt` resolve the file while `-am`, `-ammsg`,
        // `-mFgood.txt` let the inline `-m` win.
        let inlineBreak = false;
        for (let k = 1; k < word.length; k++) {
          const ch = word[k]!;
          if (ch === "m") {
            enfLog.debug("commitMessageSpecs inline cluster wins", word);
            sawFileFlag = false;
            operand = null;
            inlineBreak = true;
            break;
          }
          if (ch === "F") {
            sawFileFlag = true;
            if (k + 1 < word.length) {
              operand = word.slice(k + 1);
            } else {
              const next = words[i + 1];
              if (next && !next.startsWith("#")) {
                operand = next;
                i++;
              } else {
                enfLog.debug("commitMessageSpecs missing operand", word);
                operand = null;
              }
            }
            break;
          }
          if (!/[a-zA-Z]/.test(ch)) break;
        }
        if (inlineBreak) break;
      } else if ((word.startsWith("'") || word.startsWith('"')) && /^-[a-zA-Z]*m/.test(tokenize(word)[0] ?? "")) {
        enfLog.debug("commitMessageSpecs quoted inline cluster wins", word);
        sawFileFlag = false;
        operand = null;
        break;
      }
    }
    if (!sawFileFlag) return { kind: "inline" };
    const value = operand === null ? "" : operandBeforeShellSyntax(operand);
    if (value === "-") return { kind: "inline" };
    if (value === "") return { kind: "opaque-file", raw: operand ?? "" };
    const invocationCwd = cwdAt(span.stripped, span.start, sessionCwd);
    if (path.isAbsolute(value)) {
      return { kind: "file", path: value, rawOperand: value, cwd: invocationCwd ?? sessionCwd };
    }
    if (invocationCwd === null) {
      enfLog.debug("commitMessageSpecs opaque cwd for relative operand", value);
      return { kind: "opaque-file", raw: value };
    }
    return { kind: "file", path: join(invocationCwd, value), rawOperand: value, cwd: invocationCwd };
  });
  enfLog.debug(
    "commitMessageSpecs",
    `segments=${specs.length} files=${specs.filter((s) => s.kind === "file").length} opaqueFiles=${specs.filter((s) => s.kind === "opaque-file").length}`,
  );
  return specs;
}

/**
 * The message source of EVERY real `git commit` in the command — one entry per
 * commit segment, already resolved against the directory THAT invocation runs
 * in: the `-F <file>` path, or null when that segment's message is not a file
 * the hook can read (`-F -` is stdin, a `-m` message is inline, or an opaque
 * `-F` operand cannot be resolved).
 */
export function commitMessageFiles(command: string, sessionCwd: string): Array<string | null> {
  return commitMessageSpecs(command, sessionCwd).map((s) => (s.kind === "file" ? s.path : null));
}

function hasDynamicExpansion(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 >= raw.length) return true;
        const next = raw[i + 1]!;
        if (next === "\n" || (next === "\r" && raw[i + 2] === "\n")) return true;
        i++;
        continue;
      }
      if (ch === "$" || ch === "`") return true;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= raw.length) return true;
      const next = raw[i + 1]!;
      if (next === "\n" || (next === "\r" && raw[i + 2] === "\n")) return true;
      i++;
      continue;
    }
    if (ch === "$" || ch === "`") return true;
  }
  return quote !== null;
}

function segmentDirShifts(segment: string): { envDirs: string[]; gitDirs: string[]; opaque: boolean } {
  const words = rawShellWords(segment);
  const envDirs: string[] = [];
  const gitDirs: string[] = [];
  let i = 0;
  const unq = (w: string) => tokenize(w)[0] ?? "";
  while (i < words.length) {
    const raw = words[i]!;
    const tok = unq(raw).replace(/^[!{]+/, "");
    if (!tok) { i++; continue; }
    if (
      tok === "if" || tok === "then" || tok === "else" || tok === "elif" ||
      tok === "do" || tok === "time" || tok === "nohup" || tok === "command" ||
      tok === "builtin" || tok === "exec" || /^[A-Za-z_]\w*=/.test(raw)
    ) {
      if (tok === "time" && unq(words[i + 1] ?? "") === "-p") i++;
      if (tok === "exec" && unq(words[i + 1] ?? "") === "-a") i += 2;
      i++;
      continue;
    }
    if (tok === "env" || tok.endsWith("/env")) {
      i++;
      while (i < words.length) {
        const curRaw = words[i]!;
        const cur = unq(curRaw);
        if (/^[A-Za-z_]\w*=/.test(curRaw) || /^[A-Za-z_]\w*=/.test(cur)) { i++; continue; }
        if (!cur.startsWith("-") || cur === "-") break;
        if (cur === "--") { i++; break; }
        if (cur === "-C" || cur === "--chdir") {
          const valRaw = words[i + 1];
          if (!valRaw || hasDynamicExpansion(valRaw)) {
            enfLog.debug("segmentDirShifts opaque env chdir", cur, valRaw ?? "");
            return { envDirs, gitDirs, opaque: true };
          }
          const val = unq(valRaw);
          if (val) envDirs.push(val);
          i += 2;
          continue;
        }
        if (curRaw.startsWith("--chdir=")) {
          const valRaw = curRaw.slice("--chdir=".length);
          if (!valRaw || hasDynamicExpansion(valRaw)) {
            enfLog.debug("segmentDirShifts opaque env --chdir=", valRaw);
            return { envDirs, gitDirs, opaque: true };
          }
          const val = unq(valRaw);
          if (val) envDirs.push(val);
          i++;
          continue;
        }
        if (curRaw.startsWith("-") && !curRaw.startsWith("--") && curRaw.length > 1) {
          let handled = false;
          for (let k = 1; k < curRaw.length; k++) {
            const ch = curRaw[k]!;
            if (ch === "u" || ch === "a" || ch === "S") {
              // Option takes an argument; remainder of word (or next word) is its value.
              i += k + 1 < curRaw.length || words[i + 1] === undefined ? 1 : 2;
              handled = true;
              break;
            }
            if (ch === "C") {
              if (k + 1 < curRaw.length) {
                const valRaw = curRaw.slice(k + 1);
                if (hasDynamicExpansion(valRaw)) {
                  enfLog.debug("segmentDirShifts opaque env short chdir", curRaw, valRaw);
                  return { envDirs, gitDirs, opaque: true };
                }
                const val = unq(valRaw);
                if (val) envDirs.push(val);
                i++;
              } else {
                const valRaw = words[i + 1];
                if (!valRaw || hasDynamicExpansion(valRaw)) {
                  enfLog.debug("segmentDirShifts opaque env short chdir", curRaw, valRaw ?? "");
                  return { envDirs, gitDirs, opaque: true };
                }
                const val = unq(valRaw);
                if (val) envDirs.push(val);
                i += 2;
              }
              handled = true;
              break;
            }
            if (!/[a-zA-Z]/.test(ch)) break;
          }
          if (handled) continue;
        }
        const optName = cur.split("=")[0]!;
        if (!cur.includes("=") && ENV_VALUE_OPTIONS.has(optName) && words[i + 1] !== undefined) {
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (WRAPPER_WORDS.has(tok)) {
      i++;
      while (i < words.length) {
        const cur = unq(words[i]!);
        if (!cur.startsWith("-") || cur === "-") break;
        if (cur === "--") { i++; break; }
        const optName = cur.split("=")[0]!;
        const takesValue =
          WRAPPER_VALUE_OPTIONS.has(optName) ||
          optName === "-D" || optName === "-n" || optName === "--adjustment" ||
          optName === "-s" || optName === "--signal" || optName === "-k" || optName === "--kill-after";
        if (!cur.includes("=") && takesValue && words[i + 1] !== undefined) {
          i += 2;
        } else {
          i++;
        }
      }
      if (tok === "timeout" && i < words.length && !unq(words[i]!).startsWith("-")) i++;
      continue;
    }
    if (tok === "git" || tok.endsWith("/git")) {
      for (let j = i + 1; j < words.length; j++) {
        const curRaw = words[j]!;
        const cur = unq(curRaw);
        if (!cur.startsWith("-") || cur === "-" || cur === "--") break;
        if (cur === "-C") {
          const valRaw = words[j + 1];
          if (!valRaw || hasDynamicExpansion(valRaw)) {
            enfLog.debug("segmentDirShifts opaque git -C", valRaw ?? "");
            return { envDirs, gitDirs, opaque: true };
          }
          const val = unq(valRaw);
          if (val) gitDirs.push(val);
          j++;
          continue;
        }
        if (curRaw.startsWith("-C") && curRaw.length > 2) {
          const valRaw = curRaw.slice(2);
          if (hasDynamicExpansion(valRaw)) {
            enfLog.debug("segmentDirShifts opaque git -C attached", valRaw);
            return { envDirs, gitDirs, opaque: true };
          }
          const val = unq(valRaw);
          if (val) gitDirs.push(val);
          continue;
        }
        if (!cur.includes("=") && words[j + 1] && !unq(words[j + 1]!).startsWith("-")) j++;
      }
      break;
    }
    break;
  }
  return { envDirs, gitDirs, opaque: false };
}

/** The directory the `git` invocation ending at `anchorStart` runs in: the
 *  shell's own `cd` chain up to it, then any `env -C`/`--chdir` and `git -C`
 *  overrides on that invocation. Same rules as resolveEffectiveCwd, anchored per
 *  invocation — returns null when an unresolvable wrapper/git `-C` expansion
 *  appears so relative `-F` files fail closed as opaque. */
function cwdAt(command: string, anchorStart: number, sessionCwd: string): string | null {
  const segments = unquotedSegments(command.slice(0, anchorStart));
  const anchor = segments[segments.length - 1];
  if (!anchor) {
    enfLog.debug("cwdAt missing anchor, using sessionCwd", sessionCwd);
    return sessionCwd;
  }
  const running: string[] = [sessionCwd];
  for (const seg of segments) {
    // A segment deeper than the invocation runs in a subshell that has already
    // closed by the time it starts, so it cannot have moved this shell.
    if (seg.depth > anchor.depth) {
      enfLog.debug("cwdAt skip deeper subshell segment", seg.depth, anchor.depth);
      continue;
    }
    while (running.length <= seg.depth) running.push(running[running.length - 1]!);
    const target = cdTargetIn(seg.text);
    if (!target || target === "~popd") continue;
    running[seg.depth] = applyCd(running[seg.depth]!, target);
  }
  while (running.length <= anchor.depth) running.push(running[running.length - 1]!);
  let dir = running[anchor.depth]!;
  const shifts = segmentDirShifts(anchor.text);
  if (shifts.opaque) {
    enfLog.debug("cwdAt opaque dir shift", anchor.text.trim().slice(0, 64));
    return null;
  }
  for (const target of shifts.envDirs) dir = applyCd(dir, target);
  // Git applies each -C in turn, each relative to the previous one.
  for (const target of shifts.gitDirs) dir = applyCd(dir, target, process.env.HOME ?? "~", false);
  enfLog.debug("cwdAt resolved", dir, `envC=${shifts.envDirs.length}`, `gitC=${shifts.gitDirs.length}`);
  return dir;
}

/** Split an argument region into shell words, keeping each word's quotes: a
 *  later cut at shell punctuation must tell a quoted value from syntax, and
 *  stripping the quotes first turned `-F 'msg;bad.txt'` into `msg`. */
function rawShellWords(region: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < region.length) {
    if (/\s/.test(region[i]!)) { i++; continue; }
    const start = i;
    while (i < region.length && !/\s/.test(region[i]!)) {
      const ch = region[i]!;
      if (ch === "\\") {
        if (i + 1 < region.length) { i += 2; continue; }
        enfLog.debug("rawShellWords trailing backslash");
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const close = matchingQuoteIndex(region, i);
        if (close === null) enfLog.debug("rawShellWords unclosed quote", ch);
        i = close === null ? region.length : close + 1;
        continue;
      }
      i++;
    }
    words.push(region.slice(start, i));
  }
  return words;
}

/** A raw operand word as a path: cut at the first UNQUOTED `;|&)<>\n` — the region
 *  of a subshell runs through its closing paren — never inside quotes. Returns
 *  `""` for fd/empty redirects (`2>out`, `>out`), unclosed quotes, unquoted or
 *  double-quoted POSIX line continuations (`\\\r?\n`), or operands with
 *  unescaped shell expansions (`$VAR`, `` `...` ``, unquoted leading `~`,
 *  unquoted globs `*`, `?`, `[`). */
function operandBeforeShellSyntax(raw: string): string {
  let i = 0;
  let quote: "'" | '"' | null = null;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += ch;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 >= raw.length) {
          enfLog.debug("operandBeforeShellSyntax trailing backslash in double quotes");
          return "";
        }
        const next = raw[i + 1]!;
        // Fail closed on POSIX line continuations (`\<newline>` or CRLF variant).
        if (next === "\n" || (next === "\r" && raw[i + 2] === "\n")) {
          enfLog.debug("operandBeforeShellSyntax line continuation in double quotes");
          return "";
        }
        // In POSIX double quotes, backslash only escapes $, `, ", \.
        out += next === "$" || next === "`" || next === '"' || next === "\\" ? next : ch + next;
        i += 2;
        continue;
      }
      if (ch === "$" || ch === "`") {
        enfLog.debug("operandBeforeShellSyntax expansion in double quotes", ch);
        return "";
      }
      if (ch === '"') quote = null;
      else out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= raw.length) {
        enfLog.debug("operandBeforeShellSyntax trailing backslash");
        return "";
      }
      const next = raw[i + 1]!;
      if (next === "\n" || (next === "\r" && raw[i + 2] === "\n")) {
        enfLog.debug("operandBeforeShellSyntax line continuation");
        return "";
      }
      out += next;
      i += 2;
      continue;
    }
    if (/[)|&;\n<>]/.test(ch)) {
      enfLog.debug("operandBeforeShellSyntax cut at shell syntax", ch);
      break;
    }
    if (ch === "$" || ch === "`" || ch === "*" || ch === "?" || ch === "[") {
      enfLog.debug("operandBeforeShellSyntax expansion or glob", ch);
      return "";
    }
    if (i === 0 && ch === "~") {
      enfLog.debug("operandBeforeShellSyntax leading tilde");
      return "";
    }
    out += ch;
    i++;
  }
  if (quote !== null) {
    enfLog.debug("operandBeforeShellSyntax unclosed quote", quote);
    return "";
  }
  if ((raw[i] === "<" || raw[i] === ">") && /^\d+$/.test(raw.slice(0, i))) {
    enfLog.debug("operandBeforeShellSyntax fd redirect", raw.slice(0, i));
    return "";
  }
  if (out === "") enfLog.debug("operandBeforeShellSyntax empty operand", raw);
  return out;
}

/**
 * Detect a REAL `git <sub>` invocation (sub = "commit" or "push") at a shell
 * command position — NOT a substring inside a heredoc body, string argument,
 * or file path.
 *
 * BUG #3 FIX: the old loose matcher matched the literal text `git ... commit`
 * ANYWHERE, so writing a file whose CONTENT mentions "git commit" (heredoc body), an
 * echo/string arg like `echo 'run git commit later'`, or a path like
 * `node "/tmp/git commit x.mjs"` wrongly triggered the commit/push guard.
 * This helper narrows detection to genuine invocations by (1) stripping
 * heredoc bodies and (2) requiring `git` at a command boundary (start, or
 * after ; && || | & newline ( { backtick or control-flow keywords).
 *
 * Security note: we DO NOT attempt full shell quote parsing. We block
 * conservatively — any `git <flags> <sub>` at a command boundary in the
 * (heredoc-stripped) command still blocks. This narrows false-positives
 * without opening a bypass: a real `git commit`/`git push` cannot avoid
 * appearing at a command boundary.
 */
export function isRealGitCommitOrPush(command: string): boolean {
  // Strip heredoc bodies so file CONTENT that mentions "git commit" does not count,
  // and mask quoted prose so "if git commit" inside a -m message does not either.
  const stripped = maskQuotedProse(stripHeredocBodies(command));
  for (const sub of ["commit", "push"]) {
    if (realGitSubRegex(sub).test(stripped)) {
      enfLog.debug("git_invocation_detected", sub);
      return true;
    }
  }
  return false;
}

/**
 * Inject `--signoff` into the REAL git-commit invocation only (DCO enforcement).
 *
 * BUG THIS FIXES: a naive `command.replace(/\bgit\b...commit\b/, ...)` injects
 * `--signoff` into the FIRST `git ... commit` substring anywhere in the command —
 * including a `git commit` mention INSIDE an echo/printf message body before a pipe
 * (e.g. `echo -e "...sudo -u root git commit..." | git commit -F -`), corrupting the
 * commit MESSAGE instead of the real invocation. This mirrors the trailer-injection
 * scoping in handleCommitTrailer.
 *
 * Behavior:
 *   - Pattern A (echo/printf "..." | git commit -F -): the real invocation is AFTER
 *     the last pipe. Inject into the gitPart only; never touch the echo/message body.
 *   - Pattern B (bare `git commit ...`, `git commit -m/-F ...` with no commit pipe):
 *     inject `--signoff` right after the `commit` token of the real invocation, using
 *     the same command-position/prefix boundary logic as isRealGitCommitOrPush so a
 *     `git commit` substring inside a quoted arg is never matched.
 *   - If the real invocation already has `--signoff` or `-s` -> return unchanged.
 *   - If there is no real git-commit invocation -> return unchanged.
 */
export function injectSignoff(command: string): string {
  const SIGNOFF_RE = /(?:^|\s)--signoff(?:\s|$)/;
  const SHORT_S_RE = /(?:^|\s)-s(?:\s|$)/;
  // Reuse the exact command-position/prefix construction from isRealGitCommitOrPush,
  // capturing everything up to and including the `commit` token so we can insert
  // ` --signoff` immediately after it via a NON-global replace (first real match only).
  // Shared command-position matcher (rtk/wrapper aware) — must stay in lockstep
  // with isRealGitCommitOrPush so a guarded invocation is always an injectable one.
  const commitRe = realGitSubRegex("commit", true);

  // Pattern A: echo/printf "..." | git commit -F -  (real invocation after last pipe).
  // Matching runs on PROSE-MASKED text so a `git commit` mention inside the
  // echoed string cannot absorb the signoff (Qodo round 3, PR #916); the
  // splice uses the masked match's index, valid on the raw string because
  // masking is length-preserving.
  const pipeIdx = command.lastIndexOf("|");
  if (pipeIdx !== -1) {
    const gitPart = command.slice(pipeIdx);
    const maskedGit = maskQuotedProse(gitPart);
    if (/git\s+commit\s+.*-F\s*-/.test(maskedGit)) {
      if (SIGNOFF_RE.test(gitPart) || SHORT_S_RE.test(gitPart)) return command;
      const mA = commitRe.exec(maskedGit);
      if (!mA) return command;
      enfLog.debug("injectSignoff", "pattern A (piped git commit -F -)");
      const cutA = pipeIdx + mA.index + mA[1]!.length;
      return command.slice(0, cutA) + " --signoff" + command.slice(cutA);
    }
  }

  // Pattern B: bare / inline git commit (no message pipe) — matched on the
  // masked text so prose mentions (echo "if git commit" && git commit -m x)
  // cannot take the injection; spliced at the masked index (length-preserving).
  const masked = maskQuotedProse(command);
  const m = commitRe.exec(masked);
  if (!m) return command;
  // Scope the "already signed" check to the MATCHED real invocation ONLY, not the
  // whole command. The invocation region runs from the start of the match to the
  // next UNQUOTED statement boundary (; && || | & newline) or end-of-string.
  const regionStart = m.index;
  let regionEnd = command.length;
  {
    // Escape-aware quote-state scan. In POSIX sh, backslash escapes the next char
    // ONLY inside double quotes (and unquoted); inside single quotes a backslash is
    // literal and only a `'` ends the string. A `\"` inside a double-quoted string is
    // an escaped quote (stays inside), and `\\` is an escaped backslash (does not
    // escape the following quote). Getting this right prevents a `\"` from wrongly
    // toggling quote state — which would let an inner `;`/`&`/`|` be seen as a real
    // statement boundary (or hide a real one) and miscompute the invocation region.
    let inSingle = false;
    let inDouble = false;
    for (let i = regionStart; i < command.length; i++) {
      const c = command[i];
      if (inSingle) {
        // Single quotes: no backslash processing; only `'` terminates.
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        // Double quotes: `\` escapes the next char (e.g. \" or \\) — skip it.
        if (c === "\\") { i++; continue; }
        if (c === '"') inDouble = false;
        continue;
      }
      // Unquoted: `\` escapes the next char so an escaped quote does not open a string.
      if (c === "\\") { i++; continue; }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === "\n" || c === ";" || c === "&" || c === "|") { regionEnd = i; break; }
    }
  }
  // Strip quoted substrings from the region so a `-s`/`--signoff` INSIDE the
  // -m/-F message value (e.g. `-m "fix -s bug"`) is NOT treated as already-signed.
  // Escape-aware: a `\"` inside a double-quoted span does NOT terminate it, so an
  // inner `-s`/`--signoff` fenced by escaped quotes (`-m "a \" -s \" b"`) is still
  // stripped away — otherwise it would leak out as an unquoted flag and suppress
  // injection on an unsigned real commit (DCO bypass). Double-quoted spans are
  // stripped FIRST so the single-quote regex cannot misfire on an apostrophe that
  // lives literally inside a double-quoted string. Single quotes do NOT process
  // backslashes in POSIX sh, so their regex stays escape-agnostic.
  const region = command
    .slice(regionStart, regionEnd)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'[^']*'/g, "''");
  if (SIGNOFF_RE.test(region) || SHORT_S_RE.test(region)) return command;
  enfLog.debug("injectSignoff", "pattern B (inline git commit)");
  // Splice at the masked match position — a raw replace could pick a prose
  // mention instead of the real invocation (Qodo round 3, PR #916).
  const cut = m.index + m[1]!.length;
  return command.slice(0, cut) + " --signoff" + command.slice(cut);
}

/** Detect git add --force / -f (including combined short options like -fn).
 *  Respects -- end-of-options marker and shell separators (&&, ;, |, ||). */
export function hasGitAddForce(command: string): boolean {
  // Statement-scoped and invocation-scoped: a `-f` in another statement
  // (rm -f) or inside a -m message ("git commit -m 'add -f flag'") is not a
  // `git add --force`.
  for (const region of gitSubParseRegions(command, "add")) {
    for (const token of gitAddTokens(region)) {
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
  // Statement-scoped: only the arguments of a REAL `git add` invocation count.
  // The old loose match captured across statements and into -m message text
  // ("git commit -m 'add .'" wrongly counted as a bulk add).
  for (const region of gitSubParseRegions(command, "add")) {
    for (const token of gitAddTokens(region)) {
      if (token === "--") break; // Everything after -- is a pathspec
      if (token === "." || token === "-A" || token === "--all") return true;
    }
  }
  return false;
}

const HEREDOC_DASH_BODY_RE = /<<-(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[ \t]*\2\s*(?=\n|$)/gm;
const HEREDOC_STD_BODY_RE = /<<(\s*)['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\2\s*(?=\n|$)/gm;

function replaceHeredocBodies(cmd: string, replacer: string | ((m: string) => string)): string {
  const fn = typeof replacer === "function" ? replacer : () => replacer;
  return cmd.replace(HEREDOC_DASH_BODY_RE, fn).replace(HEREDOC_STD_BODY_RE, fn);
}

/** Strip heredoc bodies from command string, preserving commands after the closing delimiter */
export function stripHeredocBodies(cmd: string): string {
  return replaceHeredocBodies(cmd, "");
}

/**
 * True when `gh pr|issue create|comment|edit` is a real invocation (command
 * boundary), not a mention inside a string/heredoc body.
 */
export function isRealGhBodyCommand(command: string): boolean {
  const stripped = stripHeredocBodies(command);
  const boundary = /(?:^|[;&|\n(){]|&&|\|\||\bthen\b|\bdo\b|\belse\b|\belif\b)\s*/.source;
  const ghExe = /(?:\S*\/)?gh\b/.source;
  const re = new RegExp(
    boundary + ghExe + String.raw`\s+(?:pr|issue)\s+(?:create|comment|edit)\b`,
  );
  const result = re.test(stripped);
  enfLog.debug("isRealGhBodyCommand", result);
  return result;
}

function commentSignatureFooter(signature: string): string {
  return `\n\n---\n*${signature}*`;
}

const ghSignatureModel = /^[\w:./+@-]+(?: [\w:./+@-]+)*$/;
const ghSignatureLine = /(^|\n|\\n)(?:(?:\n|\\n)---(?:\n|\\n))?\*Assisted-by: PI \(([^\r\n]*?)\)\*(?=\r?\n|\\n|$)/g;

function bodyAlreadySigned(text: string): boolean {
  const lines = text.matchAll(ghSignatureLine);
  for (const line of lines) {
    if (ghSignatureModel.test(line[2])) return true;
  }
  return false;
}

// Trailer-shaped line: `Token:` at line start (real newline, literal \n escape, or
// command start), then a PI trailer identity that is a PLACEHOLDER rather than a model
// id. Detection only — the hook refuses such a commit instead of rewriting text it may
// have misparsed (Qodo, PR #1004).
const placeholderTrailerLine = /(^|\n|\\n|-m\s+['"])([ \t]*[A-Za-z][A-Za-z0-9-]*:[ \t]*)PI \(\$?\{?PI_MODEL\}?|MODEL\)/g;

/** The trailer line carrying an unresolved placeholder, or null when the command has none.
 *  A `Token:` anchor keeps prose that merely mentions the placeholder out of the result. */
export function findPlaceholderTrailer(command: string): string | null {
	if (!/(?:PI_MODEL|\bMODEL\b)/.test(command)) return null;
	if (!/\bgit\s+commit\b/.test(command)) return null;
	const matches = [...command.matchAll(placeholderTrailerLine)];
	const found = matches.at(-1);
	if (!found) {
		enfLog.debug("placeholder trailer none");
		return null;
	}
	const line = `${(found[2] ?? "").trim()} PI (placeholder)`;
	enfLog.warn("placeholder trailer found", line);
	return line;
}

/** Trailers where git itself needs an address: `Co-authored-by` credits a person. */
const TRAILERS_REQUIRING_EMAIL = new Set(["co-authored-by"]);

/** The value appended after `<Trailer>:`. `Assisted-by` needs no address, `Co-authored-by`
 *  does — hosting integrations only credit a co-author through `Name <email>`. */
export function commitTrailerIdentity(trailerName: string, modelId: string): string {
	const needsEmail = TRAILERS_REQUIRING_EMAIL.has(trailerName.trim().toLowerCase());
	const identity = needsEmail ? `PI (${modelId}) <noreply@pi.dev>` : `PI (${modelId})`;
	enfLog.debug("commit_trailer_identity", trailerName, needsEmail);
	return identity;
}

/** Does a `-F <file>` commit message already carry the trailer?
 *  The caller injects the reader so the decision is testable without touching disk —
 *  the hook reads the file, it does not guess from the command text (Qodo, PR #1004). */
export function messageFileTrailerState(
	filePath: string,
	trailerName: string,
	read: (path: string) => string,
): "has" | "missing" | "unreadable" {
	try {
		const state = commandHasTrailerByName(read(filePath).slice(0, 64_000), trailerName) ? "has" : "missing";
		enfLog.debug("message_file_trailer", filePath, state);
		return state;
	} catch (error: any) {
		// warn, not debug: trailer verification could not inspect the message, which is a
		// degraded guarantee an operator needs to see (Qodo, PR #1004).
		enfLog.warn("message_file_trailer unreadable", filePath, String(error?.message ?? error));
		return "unreadable";
	}
}

/** Harmless fd/null redirections allowed after the closing quote of a piped message producer. */
const HARMLESS_PRODUCER_REDIRECT_RE =
	/^(?:(?:\s+[12]|\s*&?)>>?\s*\/dev\/null(?=\s|$|[>&])|(?:\s+[12]|\s*)>&[12](?=\s|$|[>&]))*\s*$/;

const PIPE_SEGMENT_HEAD_KEYWORDS = new Set(["!", "then", "do", "else", "elif", "time", "nohup"]);
const PIPE_SUDO_NICE_VALUE_OPTIONS = new Set([...WRAPPER_VALUE_OPTIONS, "-D", "-n", "--adjustment"]);
const PIPE_ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"]);
const PIPE_TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);
const GIT_GLOBAL_SEP_VALUE_OPTS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);
const GIT_COMMIT_SEP_VALUE_OPTS = new Set([
	"--author",
	"--date",
	"--cleanup",
	"--pathspec-from-file",
	"--trailer",
	"--unified",
	"--inter-hunk-context",
	"-U",
	"-t",
	"--template",
	"--fixup",
	"--squash",
]);

interface PipeSegmentToken {
	value: string;
	unquoted: boolean;
	assignmentPrefix: boolean;
	hasExpansion: boolean;
	unquotedExpansion: boolean;
}

interface ParsedPipeSegment {
	tokens: PipeSegmentToken[];
	sawInputRedirect: boolean;
	sawStdoutRedirect: boolean;
}

/** Tokenize a single pipeline segment into shell words, tracking whether each token is
 *  strictly unquoted literal text and stripping redirections while recording fd direction. */
function tokenizePipeSegment(segment: string): ParsedPipeSegment | null {
	const tokens: PipeSegmentToken[] = [];
	let sawInputRedirect = false;
	let sawStdoutRedirect = false;
	let i = 0;

	const skipSpace = (): void => {
		while (i < segment.length) {
			const cont = skipLineContinuation(segment, i);
			if (cont > 0) { i += cont; continue; }
			if (segment[i] === " " || segment[i] === "\t" || segment[i] === "\r") { i++; continue; }
			break;
		}
	};

	const readWord = (): PipeSegmentToken | null => {
		let value = "";
		let unquoted = true;
		let rawPrefix = "";
		let sawNonLiteral = false;
		let hasExpansion = false;
		let unquotedExpansion = false;
		let has = false;
		while (i < segment.length) {
			const cont = skipLineContinuation(segment, i);
			if (cont > 0) { i += cont; continue; }
			const ch = segment[i]!;
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "<" || ch === ">") break;
			if (ch === "&" && segment[i + 1] === ">") break;
			has = true;
			if (ch === "$" && segment[i + 1] === "'") {
				unquoted = false;
				sawNonLiteral = true;
				const close = scanAnsiCQuoteEnd(segment, i + 1);
				if (close === null) return null;
				value += segment.slice(i + 2, close);
				i = close + 1;
				continue;
			}
			if (ch === "'" || ch === '"') {
				const close = matchingQuoteIndex(segment, i);
				if (close === null) return null;
				if (ch === '"') {
					for (let q = i + 1; q < close; q++) {
						if (segment[q] === "\\") { q++; continue; }
						if ((segment[q] === "$" && q + 1 < close) || segment[q] === "`") {
							hasExpansion = true;
							break;
						}
					}
				}
				unquoted = false;
				sawNonLiteral = true;
				value += segment.slice(i + 1, close);
				i = close + 1;
				continue;
			}
			if (ch === "`") {
				unquoted = false;
				sawNonLiteral = true;
				hasExpansion = true;
				unquotedExpansion = true;
				const close = scanBacktickEnd(segment, i);
				if (close === null) return null;
				value += segment.slice(i, close + 1);
				i = close + 1;
				continue;
			}
			if (ch === "$" && segment[i + 1] === "(") {
				const close = matchingSubstParenIndex(segment, i + 1);
				if (close === null) return null;
				unquoted = false;
				sawNonLiteral = true;
				hasExpansion = true;
				unquotedExpansion = true;
				value += segment.slice(i, close + 1);
				i = close + 1;
				continue;
			}
			if (ch === "$") {
				unquoted = false;
				sawNonLiteral = true;
				hasExpansion = true;
				unquotedExpansion = true;
				value += "$";
				i++;
				continue;
			}
			if (ch === "\\") {
				if (i + 1 >= segment.length) return null;
				unquoted = false;
				sawNonLiteral = true;
				value += segment[i + 1]!;
				i += 2;
				continue;
			}
			value += ch;
			if (!sawNonLiteral) rawPrefix += ch;
			i++;
		}
		if (!has) return null;
		return {
			value,
			unquoted,
			assignmentPrefix: /^[A-Za-z_]\w*=/.test(rawPrefix),
			hasExpansion,
			unquotedExpansion,
		};
	};

	while (i < segment.length) {
		skipSpace();
		if (i >= segment.length || segment[i] === "#") break;
		const redir = /^(?:\d*<<<|\d*<<-?|\d*<&|\d*<>|\d*<|&>>|&>|\d*>>|\d*>&|\d*>\|?)/.exec(segment.slice(i));
		if (redir) {
			const op = redir[0];
			if (op.includes("<")) {
				sawInputRedirect = true;
			} else {
				const fd = /^\d+/.exec(op)?.[0];
				if (op.startsWith("&") || fd === undefined || fd === "1") sawStdoutRedirect = true;
			}
			i += op.length;
			skipSpace();
			if (readWord() === null) return null;
			continue;
		}
		const word = readWord();
		if (word === null) return null;
		tokens.push(word);
	}
	return { tokens, sawInputRedirect, sawStdoutRedirect };
}

function skipPipeSegmentPrefixes(tokens: PipeSegmentToken[]): { idx: number; abortCommit: boolean } {
	let idx = 0;
	while (idx < tokens.length) {
		const tok = tokens[idx]!;
		if (tok.assignmentPrefix) { idx++; continue; }
		if (!tok.unquoted) break;
		if (PIPE_SEGMENT_HEAD_KEYWORDS.has(tok.value)) {
			idx++;
			if (tok.value === "time" && tokens[idx]?.unquoted && tokens[idx]!.value === "-p") idx++;
			continue;
		}
		if (tok.value === "rtk") {
			idx++;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-") && tokens[idx]!.value !== "-") {
				if (tokens[idx]!.value === "--") { idx++; break; }
				idx += WRAPPER_VALUE_OPTIONS.has(tokens[idx]!.value) ? 2 : 1;
			}
			continue;
		}
		if (tok.value === "command" || tok.value === "builtin" || tok.value === "exec") {
			const w = tok.value;
			idx++;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-") && tokens[idx]!.value !== "-") {
				const flag = tokens[idx]!.value;
				if (flag === "--") { idx++; break; }
				if (w === "command" && /^-[a-zA-Z]*[vV]/.test(flag)) {
					return { idx: tokens.length, abortCommit: false };
				}
				idx += w === "exec" && flag === "-a" ? 2 : 1;
			}
			continue;
		}
		if (tok.value === "env") {
			idx++;
			while (idx < tokens.length) {
				const cur = tokens[idx]!;
				if (cur.assignmentPrefix || /^[A-Za-z_]\w*=/.test(cur.value)) { idx++; continue; }
				if (!cur.value.startsWith("-") || cur.value === "-") break;
				if (cur.value === "--") { idx++; break; }
				if (cur.value.startsWith("-S") || cur.value === "--split-string" || cur.value.startsWith("--split-string=")) {
					const restText = tokens.slice(idx).map((t) => t.value).join(" ");
					return { idx: tokens.length, abortCommit: /\bgit\b[\s\S]*\bcommit\b/.test(restText) };
				}
				idx += PIPE_ENV_VALUE_OPTIONS.has(cur.value) ? 2 : 1;
			}
			continue;
		}
		if (tok.value === "sudo" || tok.value === "nice") {
			idx++;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-") && tokens[idx]!.value !== "-") {
				const flag = tokens[idx]!.value;
				if (flag === "--") { idx++; break; }
				idx += PIPE_SUDO_NICE_VALUE_OPTIONS.has(flag) ? 2 : 1;
			}
			continue;
		}
		if (tok.value === "timeout") {
			idx++;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-") && tokens[idx]!.value !== "-") {
				const flag = tokens[idx]!.value;
				if (flag === "--") { idx++; break; }
				idx += PIPE_TIMEOUT_VALUE_OPTIONS.has(flag) ? 2 : 1;
			}
			if (idx < tokens.length) idx++;
			continue;
		}
		break;
	}
	return { idx, abortCommit: false };
}

/** True only when an intermediate pipeline segment is a `tee` stage that passes stdin to stdout unchanged. */
function isPassthroughTeeSegment(segment: string): boolean {
	const parsed = tokenizePipeSegment(segment);
	if (!parsed || parsed.sawInputRedirect || parsed.sawStdoutRedirect) return false;
	const { idx, abortCommit } = skipPipeSegmentPrefixes(parsed.tokens);
	if (abortCommit) return false;
	const cmdTok = parsed.tokens[idx];
	if (!cmdTok || !cmdTok.unquoted || !(cmdTok.value === "tee" || cmdTok.value.endsWith("/tee"))) return false;
	for (let k = idx + 1; k < parsed.tokens.length; k++) {
		const tok = parsed.tokens[k]!;
		if (tok.value === "-") return false;
		if (tok.unquoted && (tok.value === "--help" || tok.value === "--version")) return false;
	}
	return true;
}

/** Classify a pipeline's final segment using unquoted command/option tokens only. */
function classifyPipedFinalSegment(segment: string): "piped_stdin" | "unsafe_commit" | "not_commit" {
	const parsed = tokenizePipeSegment(segment);
	if (!parsed) return "unsafe_commit";
	const { idx, abortCommit } = skipPipeSegmentPrefixes(parsed.tokens);
	if (abortCommit) return "unsafe_commit";
	const cmdTok = parsed.tokens[idx];
	if (!cmdTok) return "not_commit";
	if (!(cmdTok.value === "git" || cmdTok.value.endsWith("/git"))) {
		return realGitSub(segment, "commit") ? "unsafe_commit" : "not_commit";
	}
	let k = idx + 1;
	while (k < parsed.tokens.length && parsed.tokens[k]!.value.startsWith("-") && parsed.tokens[k]!.value !== "-") {
		const optTok = parsed.tokens[k]!;
		if (optTok.value === "--") { k++; break; }
		if (GIT_GLOBAL_SEP_VALUE_OPTS.has(optTok.value)) {
			if (!optTok.unquoted || !parsed.tokens[k + 1] || parsed.tokens[k + 1]!.unquotedExpansion) {
				return "unsafe_commit";
			}
			k += 2;
			continue;
		}
		if (optTok.hasExpansion) return "unsafe_commit";
		k++;
	}
	const subTok = parsed.tokens[k];
	if (!subTok) return "not_commit";
	if (subTok.hasExpansion) return "unsafe_commit";
	if (subTok.value !== "commit") return "not_commit";
	if (!cmdTok.unquoted || !subTok.unquoted || parsed.sawInputRedirect) return "unsafe_commit";

	let sawStdinFile = false;
	for (let m = k + 1; m < parsed.tokens.length; m++) {
		const tok = parsed.tokens[m]!;
		if (tok.unquoted && tok.value === "--") break;
		if (tok.value === "-F" || tok.value === "--file" || /^-[apzsnveioq]+F$/.test(tok.value)) {
			const arg = parsed.tokens[m + 1];
			if (!tok.unquoted || !arg || !arg.unquoted || arg.value !== "-" || sawStdinFile) return "unsafe_commit";
			sawStdinFile = true;
			m++;
			continue;
		}
		if (tok.value === "-F-" || /^-[apzsnveioq]+F-$/.test(tok.value) || tok.value === "--file=-") {
			if (!tok.unquoted || sawStdinFile) return "unsafe_commit";
			sawStdinFile = true;
			continue;
		}
		if (tok.value.startsWith("-F") || /^-[apzsnveioq]+F./.test(tok.value) || tok.value.startsWith("--file=")) {
			return "unsafe_commit";
		}
		if (
			tok.value === "-m" ||
			tok.value === "--message" ||
			/^-[apzsnveioq]*m/.test(tok.value) ||
			tok.value.startsWith("--message=") ||
			tok.value === "-C" ||
			tok.value === "--reuse-message" ||
			tok.value.startsWith("-C") ||
			tok.value.startsWith("--reuse-message=") ||
			tok.value === "-c" ||
			tok.value === "--reedit-message" ||
			tok.value.startsWith("-c") ||
			tok.value.startsWith("--reedit-message=")
		) {
			return "unsafe_commit";
		}
		if (GIT_COMMIT_SEP_VALUE_OPTS.has(tok.value)) {
			if (!tok.unquoted || !parsed.tokens[m + 1] || parsed.tokens[m + 1]!.unquotedExpansion) return "unsafe_commit";
			m++;
			continue;
		}
		if (tok.hasExpansion) return "unsafe_commit";
	}
	return sawStdinFile ? "piped_stdin" : "unsafe_commit";
}

function segmentInvokesGitCommit(segment: string): boolean {
	const parsed = tokenizePipeSegment(segment);
	if (!parsed) return true;
	const { idx, abortCommit } = skipPipeSegmentPrefixes(parsed.tokens);
	if (abortCommit) return true;
	const cmdTok = parsed.tokens[idx];
	if (!cmdTok) return false;
	if (!(cmdTok.value === "git" || cmdTok.value.endsWith("/git"))) {
		return realGitSub(segment, "commit");
	}
	let k = idx + 1;
	while (k < parsed.tokens.length && parsed.tokens[k]!.value.startsWith("-") && parsed.tokens[k]!.value !== "-") {
		const flag = parsed.tokens[k]!.value;
		if (flag === "--") { k++; break; }
		k += GIT_GLOBAL_SEP_VALUE_OPTS.has(flag) ? 2 : 1;
	}
	const subTok = parsed.tokens[k];
	return Boolean(subTok && (subTok.value === "commit" || subTok.hasExpansion));
}

interface PipedCommitSpan {
	stmtStart: number;
	firstPipeIdx: number;
	lastPipeIdx: number;
	stmtEnd: number;
	lastQuoteIdx: number;
}

/** Locate every `… | git commit … -F -` pipeline in `command`, honoring quotes,
 *  substitutions, heredocs, comments, and statement boundaries. Returns `null` when
 *  a pipeline invokes `git commit` in a non-injectable shape or has broken quoting. */
function findPipedCommitSpans(command: string): PipedCommitSpan[] | null {
	let stmtStart = 0;
	let pipeOps: Array<{ start: number; end: number }> = [];
	let lastQuoteIdx = -1;
	let nonPipedCommits = 0;
	const spans: PipedCommitSpan[] = [];
	const pendingHeredocs: Array<{ delim: string; stripTabs: boolean }> = [];

	const finishStatement = (stmtEnd: number): boolean => {
		if (pipeOps.length > 0) {
			const lastPipe = pipeOps[pipeOps.length - 1]!;
			const kind = classifyPipedFinalSegment(command.slice(lastPipe.end, stmtEnd));
			if (kind === "unsafe_commit") return false;
			if (kind === "piped_stdin") {
				for (let p = 0; p < pipeOps.length - 1; p++) {
					if (!isPassthroughTeeSegment(command.slice(pipeOps[p]!.end, pipeOps[p + 1]!.start))) {
						return false;
					}
				}
				spans.push({
					stmtStart,
					firstPipeIdx: pipeOps[0]!.start,
					lastPipeIdx: lastPipe.start,
					stmtEnd,
					lastQuoteIdx,
				});
			}
		} else if (segmentInvokesGitCommit(command.slice(stmtStart, stmtEnd))) {
			nonPipedCommits++;
		}
		stmtStart = stmtEnd;
		pipeOps = [];
		lastQuoteIdx = -1;
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (ch === "#" && (i === 0 || /[\s(;&|]/.test(command[i - 1]!))) {
			i = skipLineComment(command, i) - 1;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const m = matchHeredocOpener(command.slice(i), "piped-commit");
			if (m) {
				pendingHeredocs.push({ delim: m.delim, stripTabs: m.stripTabs });
				i += m.length - 1;
				continue;
			}
		}
		if (ch === "'" && i > 0 && command[i - 1] === "$") {
			const close = scanAnsiCQuoteEnd(command, i);
			if (close === null) return null;
			i = close;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const close = matchingQuoteIndex(command, i);
			if (close === null) return null;
			if (pipeOps.length === 0 && !(ch === '"' && i > 0 && command[i - 1] === "$") && !/[<>]\s*$/.test(command.slice(stmtStart, i))) {
				lastQuoteIdx = close;
			}
			i = close;
			continue;
		}
		if (ch === "`") {
			const close = scanBacktickEnd(command, i);
			if (close === null) return null;
			i = close;
			continue;
		}
		if (ch === "(" && i > 0 && (command[i - 1] === "$" || command[i - 1] === "<" || command[i - 1] === ">")) {
			const close = matchingSubstParenIndex(command, i);
			if (close === null) return null;
			i = close;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			if (!finishStatement(i)) return null;
			i++;
			stmtStart = i + 1;
			continue;
		}
		if (two === "|&") {
			pipeOps.push({ start: i, end: i + 2 });
			i++;
			continue;
		}
		if (ch === "\n") {
			if (!finishStatement(i)) return null;
			if (pendingHeredocs.length > 0) {
				const { next, closed } = skipHeredocBody(command, i + 1, pendingHeredocs, { stripCr: true });
				if (!closed) return null;
				pendingHeredocs.length = 0;
				stmtStart = next;
				i = next - 1;
				continue;
			}
			stmtStart = i + 1;
			continue;
		}
		if (ch === ";" || ch === "(" || ch === ")") {
			if (!finishStatement(i)) return null;
			stmtStart = i + 1;
			continue;
		}
		if (
			(ch === "{" || ch === "}") &&
			(i === 0 || /[\s;&|()]/.test(command[i - 1]!)) &&
			(i + 1 >= command.length || /[\s;&|()]/.test(command[i + 1]!))
		) {
			if (!finishStatement(i)) return null;
			stmtStart = i + 1;
			continue;
		}
		if (ch === "&") {
			if (command[i - 1] === ">" || command[i + 1] === ">" || command[i - 1] === "<") continue;
			if (!finishStatement(i)) return null;
			stmtStart = i + 1;
			continue;
		}
		if (ch === "|") {
			pipeOps.push({ start: i, end: i + 1 });
		}
	}
	if (!finishStatement(command.length)) return null;
	if (spans.length > 0 && nonPipedCommits > 0) return null;
	if (spans.length === 0 && nonPipedCommits > 1) return null;
	return spans;
}

/** End offsets of every real `git commit` subcommand token in `command` (length-preserving). */
function realCommitEndOffsets(command: string): number[] {
	const blankBodyOnly = (m: string) => {
		const nl = m.indexOf("\n");
		return nl === -1 ? m : m.slice(0, nl + 1) + m.slice(nl + 1).replace(/[^\n]/g, " ");
	};
	const heredocBlanked = replaceHeredocBodies(command, blankBodyOnly);
	const masked = maskQuotedProse(heredocBlanked);
	const re = new RegExp(realGitSubRegex("commit").source, "g");
	return [...masked.matchAll(re)].map((m) => (m.index ?? 0) + m[0].length);
}

/** Append `<Trailer>: PI (<model>)` to the message of a real commit invocation.
 *  Covers the two shapes whose message the hook can see — `echo … | git commit -F -`
 *  and `git commit -m "…"` — and returns null when the trailer is already there or
 *  the shape is not covered. Pure so the injection path is testable without a hook. */
export function injectCommitTrailer(command: string, trailerName: string, modelId: string): string | null {
	const identity = commitTrailerIdentity(trailerName, modelId);
	// Pattern A: echo "..." [| tee ...] | git commit -F -
	const pipedSpans = findPipedCommitSpans(command);
	if (pipedSpans === null) {
		enfLog.debug("inject_commit_trailer", "unsafe piped commit", trailerName, command.trim().slice(0, 64));
		return null;
	}
	const commitEnds = realCommitEndOffsets(command);
	if (pipedSpans.length > 0) {
		const hitsPerSpan = new Uint32Array(pipedSpans.length);
		for (const end of commitEnds) {
			const spanIdx = pipedSpans.findIndex((s) => s.lastPipeIdx < end && end <= s.stmtEnd);
			if (spanIdx === -1 || ++hitsPerSpan[spanIdx]! > 1) {
				enfLog.debug("inject_commit_trailer", "unaccounted commit", trailerName, command.trim().slice(0, 64));
				return null;
			}
		}
		const splices: Array<{ index: number; text: string }> = [];
		for (const pipedSpan of pipedSpans) {
			const producerPart = command.slice(pipedSpan.stmtStart, pipedSpan.firstPipeIdx);
			const leadingAssignMatch = /^(?:\s*[A-Za-z_]\w*=(?:"(?:\\.|[^"\\])*"|'[^']*'|\S*)(?=\s|$))*/.exec(producerPart);
			const producerCmdOffset = pipedSpan.stmtStart + (leadingAssignMatch?.[0].length ?? 0);
			if (pipedSpan.lastQuoteIdx < producerCmdOffset) {
				enfLog.debug("inject_commit_trailer", "no quoted operand", trailerName, producerPart.trim().slice(0, 64));
				return null;
			}
			const trailing = command.slice(pipedSpan.lastQuoteIdx + 1, pipedSpan.firstPipeIdx);
			if (!HARMLESS_PRODUCER_REDIRECT_RE.test(trailing.replace(/\\\r?\n/g, " "))) {
				enfLog.debug("inject_commit_trailer", "unquoted trailing operand", trailerName, trailing.trim().slice(0, 64));
				return null;
			}
			if (commandHasTrailerByName(command.slice(producerCmdOffset, pipedSpan.firstPipeIdx), trailerName)) {
				enfLog.debug("inject_commit_trailer", "already present", trailerName);
				continue;
			}
			const quoteChar = command[pipedSpan.lastQuoteIdx];
			const escaped = quoteChar === "'"
				? `${escapeForSingleQuote(trailerName)}: ${identity}`
				: `${escapeForDoubleQuote(trailerName)}: ${identity}`;
			splices.push({ index: pipedSpan.lastQuoteIdx, text: `\n\n${escaped}` });
		}
		if (splices.length === 0) return null;
		let out = command;
		for (let i = splices.length - 1; i >= 0; i--) {
			const splice = splices[i]!;
			out = out.slice(0, splice.index) + splice.text + out.slice(splice.index);
		}
		enfLog.info("inject_commit_trailer", "piped", trailerName, splices.length);
		return out;
	}
	if (commitEnds.length !== 1) {
		if (commitEnds.length > 1) {
			enfLog.debug("inject_commit_trailer", "multiple inline commits", trailerName, command.trim().slice(0, 64));
		}
		return null;
	}
	// Pattern B: git commit -m "..." or git commit -m '...'
	const mFlagMatch = command.match(/git\s+commit\s+.*-m\s+(["'])([\s\S]*?)\1/);
	if (!mFlagMatch) return null;
	// Every `-m` is a message paragraph, so an existing trailer in ANY of them wins.
	const allPayloads = [...command.matchAll(/-m\s+(["'])([\s\S]*?)\1/g)].map((m) => m[2] ?? "").join("\n");
	if (commandHasTrailerByName(allPayloads, trailerName)) {
		enfLog.debug("inject_commit_trailer", "already present", trailerName);
		return null;
	}
	const quoteChar = mFlagMatch[1];
	const escaped = quoteChar === "'"
		? `${escapeForSingleQuote(trailerName)}: ${identity}`
		: `${escapeForDoubleQuote(trailerName)}: ${identity}`;
	const fullMatch = mFlagMatch[0];
	const insertPos = command.indexOf(fullMatch) + fullMatch.length - 1;
	enfLog.info("inject_commit_trailer", "inline", trailerName);
	return command.slice(0, insertPos) + `\n\n${escaped}` + command.slice(insertPos);
}

/** Keep the first standalone valid footer, but use the current operation's model. */
function normalizeGhBodyFooters(payload: string, signature: string): string {
  let signed = false;
  return payload.replace(ghSignatureLine, (block, _prefix: string, model: string) => {
    if (model.includes("PI_MODEL")) {
      enfLog.debug("injectGhBodySignature removed unresolved PI_MODEL footer");
      return "";
    }
    if (ghSignatureModel.test(model)) {
      if (signed) {
        enfLog.debug("injectGhBodySignature removed duplicate valid footer", model);
        return "";
      }
      signed = true;
      if (`Assisted-by: PI (${model})` !== signature) {
        enfLog.debug("injectGhBodySignature replaced stale footer", model);
        return block.replace(`*Assisted-by: PI (${model})*`, `*${signature}*`);
      }
    }
    return block;
  });
}

/** Closing paren of a `$(...)`, `<(...)`, or `>(...)`, honoring quotes, escapes, comments, and heredocs. */
function matchingSubstParenIndex(s: string, openParenIdx: number): number | null {
  return scanBalancedParen(s, openParenIdx, {
    honorComments: true,
    honorHeredocs: true,
    honorAnsiC: true,
    honorBacktick: true,
    recurseDoubleQuote: true,
    unquotedEscapes: true,
  });
}

/** Index of the matching closer for a quote at `openIdx`, honoring POSIX escapes and inline heredocs. */
function matchingQuoteIndex(s: string, openIdx: number): number | null {
  const close = scanDoubleQuoteEnd(s, openIdx, { honorHeredocs: true, honorBacktick: false });
  enfLog.debug("matchingQuoteIndex", s[openIdx] === "'" ? "single" : "double", close !== null);
  return close;
}

/**
 * Last quoted `--body` / `--body=` span in `command`. Conservative: unquoted
 * or unclosed values are skipped (caller no-ops).
 */
function findLastQuotedBodySpan(command: string): { open: number; close: number } | null {
  const flagRe = /--body(?:=|\s+)/g;
  let last: { open: number; close: number } | null = null;
  let fm: RegExpExecArray | null;
  while ((fm = flagRe.exec(command)) !== null) {
    const after = fm.index + fm[0].length;
    const q = command[after];
    if (q !== '"' && q !== "'") {
      enfLog.debug("findLastQuotedBodySpan skip unquoted --body");
      continue;
    }
    const close = matchingQuoteIndex(command, after);
    if (close == null) {
      enfLog.warn("findLastQuotedBodySpan unclosed --body quote");
      continue;
    }
    last = { open: after, close };
  }
  enfLog.debug("findLastQuotedBodySpan", last ? "found" : "none");
  return last;
}

function lastHeredocInSpan(
  command: string,
  spanStart: number,
  spanEnd: number,
): RegExpExecArray | null {
  const heredocRe = /<<-?[ \t]*(['"]?)([\w-]+)\1[^\n]*\n([\s\S]*?)\n([ \t]*)\2\r?(?=\n|$)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = heredocRe.exec(command)) !== null) {
    if (m.index > spanStart && m.index < spanEnd) last = m;
  }
  enfLog.debug("lastHeredocInSpan", last ? last[2] : "none");
  return last;
}

/**
 * Append the comment_signature footer to `gh pr|issue create|comment|edit`
 * `--body` / heredoc payloads. Idempotent. Empty signature is a no-op.
 * Only mutates a heredoc that sits inside the `--body` quoted span.
 */
export function injectGhBodySignature(command: string, signature: string): string {
  if (!signature) {
    enfLog.debug("injectGhBodySignature skip empty signature");
    return command;
  }
  if (!isRealGhBodyCommand(command)) {
    enfLog.debug("injectGhBodySignature skip not a gh body command");
    return command;
  }
  const footer = commentSignatureFooter(signature);
  const span = findLastQuotedBodySpan(command);
  if (!span) {
    enfLog.debug("injectGhBodySignature no quoted --body found");
    return command;
  }

  const payload = command.slice(span.open + 1, span.close);
  const normalizedPayload = normalizeGhBodyFooters(payload, signature);
  if (normalizedPayload !== payload) {
    // Re-parse positions after cleanup so command-substitution heredocs still
    // receive their footer before the closing delimiter.
    const normalizedCommand = command.slice(0, span.open + 1) + normalizedPayload + command.slice(span.close);
    return injectGhBodySignature(normalizedCommand, signature);
  }
  if (bodyAlreadySigned(payload)) {
    enfLog.debug("injectGhBodySignature skip already present in body");
    return command;
  }

  const last = lastHeredocInSpan(command, span.open, span.close);
  if (last) {
    const delim = last[2];
    const indent = last[4] ?? "";
    const closeToken = `\n${indent}${delim}`;
    const closeIdx = last.index + last[0].lastIndexOf(closeToken);
    if (closeIdx >= last.index) {
      enfLog.debug("injectGhBodySignature heredoc in --body", delim);
      const crlf = command[closeIdx - 1] === "\r";
      const insertAt = crlf ? closeIdx - 1 : closeIdx;
      return command.slice(0, insertAt) + (crlf ? footer.replaceAll("\n", "\r\n") : footer) + command.slice(insertAt);
    }
  }

  if (payload.startsWith("$(")) {
    enfLog.warn("injectGhBodySignature --body command subst without heredoc match");
    return command;
  }
  enfLog.debug("injectGhBodySignature --body quoted");
  return command.slice(0, span.close) + footer + command.slice(span.close);
}

/**
 * Detect common test runner commands — require command-start position
 * (after &&, |, ;, a newline, or line start) to avoid false positives from install/grep/cat commands.
 * `pre-commit` counts only when its `run` subcommand is executed; setup and information
 * commands must not mark tests as passed.
 * NOTE: For compound commands (e.g., pytest && other_cmd), if the non-test part fails,
 * isError=true marks tests as failed even though pytest passed. This is the conservative/safe
 * direction — re-run the test command standalone to mark tests_passed.
 * NOTE: `tox` without `-e` args matches (runs default envs = tests). `tox -e lint` does NOT
 * match — we exclude tox with explicit -e to avoid marking lint/docs runs as test passes.
 */
export function isTestRunnerCommand(command: string): boolean {
  const result = /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?(?:pytest|vitest|jest|mocha)\b/.test(command)
    || /(?:^|[;&|]\s*)(?:uv\s+run\s+(?:--\S+(?:\s+\S+)?\s+)*)?tox\b(?!\s*-e)(?!\s+--(?:help|version|list))/.test(command)
    || /(?:^|[;&|]\s*)go\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npm\s+test\b/.test(command)
    || /(?:^|[;&|]\s*)npx\s+tsx\s+--test\b/.test(command)
    || /(?:^|[;&|\n]\s*)pre-commit\s+run\b/.test(command);
  enfLog.debug("isTestRunnerCommand", result);
  return result;
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

/** Diagnostic for a FAILED edit/write skipping file_modified triggers
 *  (#940, Qodo 2addbfc4): nothing was modified, so file-pattern rules must
 *  not fire. Logs at debug level itself (Qodo ea636782 — logging
 *  requirements apply to helpers too) and returns the message for tests. */
export function failedFileEditSkipMessage(toolName: string, path: string): string {
  const msg = `enforcement: failed ${toolName} (path=${path}) — skipping file_modified triggers, nothing was modified`;
  enfLog.debug(msg);
  return msg;
}

// ── Deep Policy Evaluation Interface ────────────────────────────────────────

/** Placeholder strings that are never a real model id — printing one in a trailer ships a bug. */
const PLACEHOLDER_MODEL_IDS = new Set(["model", "pi_model", "$pi_model", "${pi_model}", "unknown"]);

/** Resolve the model id used in commit trailers (env first, then ctx model id). */
export function resolveCommitTrailerModelId(ctxModelId?: string | null): string {
  for (const raw of [process.env.PI_PRIMARY_MODEL, process.env.PI_MODEL, ctxModelId]) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;
    if (PLACEHOLDER_MODEL_IDS.has(trimmed.toLowerCase())) {
      enfLog.debug("commit_trailer: skipped placeholder model id", trimmed);
      continue;
    }
    const clean = sanitizeModelId(trimmed);
    if (clean) return clean;
  }
  enfLog.warn("commit_trailer: no model id resolved — trailer identity is unknown");
  return "unknown";
}

/** Resolve the model id used in `comment_signature` footers (ctx model id first, then env). */
export function resolveCommentSignatureModelId(ctxModelId?: string | null): string {
  return (
    sanitizeModelId(ctxModelId || process.env.PI_MODEL || process.env.PI_PRIMARY_MODEL) || "unknown"
  );
}

function lstatStamp(p: string): string {
  try {
    const st = lstatSync(p, { bigint: true });
    return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.isSymbolicLink()}`;
  } catch {
    return "missing";
  }
}

let cachedProtectedSettings: {
  key: string;
  projectStamp: string;
  globalStamp: string;
  globalFileStamp: string;
  targets: Set<string>;
} | null = null;

function getProtectedSettingsTargets(cwd: string): Set<string> {
  const projectBase = dirname(getSettingsPath(cwd));
  const globalPath = getGlobalSettingsPath();
  const globalBase = dirname(globalPath);
  const key = `${projectBase}\0${globalBase}\0${globalPath}`;
  const projectStamp = lstatStamp(projectBase);
  const globalStamp = lstatStamp(globalBase);
  const globalFileStamp = lstatStamp(globalPath);
  if (
    cachedProtectedSettings &&
    cachedProtectedSettings.key === key &&
    cachedProtectedSettings.projectStamp === projectStamp &&
    cachedProtectedSettings.globalStamp === globalStamp &&
    cachedProtectedSettings.globalFileStamp === globalFileStamp
  ) {
    return cachedProtectedSettings.targets;
  }
  const toReal = (p: string): string => realpathNearestExisting(p) ?? p;
  const targets = new Set<string>();
  for (const base of [projectBase, globalBase]) {
    for (const name of [...SETTINGS_FILENAMES, LEGACY_SETTINGS_FILENAME]) {
      const full = join(base, name);
      targets.add(full);
      targets.add(toReal(full));
    }
  }
  targets.add(globalPath);
  targets.add(toReal(globalPath));
  cachedProtectedSettings = { key, projectStamp, globalStamp, globalFileStamp, targets };
  return targets;
}

/**
 * Evaluate direct file edit/write attempts against protected targets:
 * - `.pi/pi-config-settings.json(c)` and `~/.pi/pi-config-settings.json(c)` (dangerous allowlist protection)
 * - Git identity config files (`~/.gitconfig`, `~/.config/git/config`, `.git/config`)
 */
export function evaluateFileWritePolicy(
  filePath: string,
  cwd: string,
): { block: true; reason: string } | undefined {
  const normalizedPath = filePath.trim().replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  const cleanPath = normalizedPath.startsWith("@") ? normalizedPath.slice(1) : normalizedPath;
  const toReal = (p: string): string => realpathNearestExisting(p) ?? p;
  const resolved = resolve(cwd, cleanPath);
  const realResolved = toReal(resolved);
  const settingsTargets = getProtectedSettingsTargets(cwd);
  if (settingsTargets.has(resolved) || settingsTargets.has(realResolved)) {
    enfLog.warn("protected_settings_file_write_blocked", { path: filePath });
    return {
      block: true,
      reason:
        "\u26d4 Direct modification of pi-config-settings blocked — it carries the dangerous-command allowlist, restricted folders, and tool permissions. Change settings via the /pi-config-settings command or your own editor, never agent tools.",
    };
  }
  if (isGitIdentityConfigPath(resolved) || isGitIdentityConfigPath(realResolved)) {
    enfLog.error("git_identity_config_file_write_blocked", { path: filePath });
    return {
      block: true,
      reason:
        "\u26d4 Git identity config is off-limits to agents. The git identity belongs to the human — " +
        "if it is wrong, tell the user to fix their own git config.",
    };
  }
  return undefined;
}

/** Minimal interactive UI surface needed by bash policy prompts. Null/undefined means headless. */
export interface BashPolicyUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): Promise<void> | void;
}

/** Input contract for the deep bash policy evaluator. */
export interface BashPolicyInput {
  command: string;
  cwd: string;
  hasTimeout?: boolean;
  inContainer?: boolean;
  isSubagentChild?: boolean;
  agentName?: string;
  ctxModelId?: string | null;
  sessionId?: string | null;
  ui?: BashPolicyUi | null;
  /** Optional session-scoped trailer selection cache for comma-separated `commit_trailer`. */
  trailerSelection?: { get(): string | null; set(value: string): void };
  /** Optional review-loop commit gate checked for `git-expert` commits before git protection. */
  checkReviewLoopCommit?: (
    gitCwd: string,
    branch: string | null,
  ) => { block: true; reason: string } | undefined;
}

/** Narrow decision returned by `evaluateBashPolicy`. */
export type BashPolicyDecision =
  | { action: "allow"; modifiedCommand?: string; stripTimeout?: boolean }
  | { action: "block"; reason: string };

interface MutableCommand {
  current: string;
  modified: boolean;
}

/** Honest failure notice for a failed approval write — names the ACTUAL
 * reason instead of a generic "settings unreadable" (Qodo PR #950 R8). */
function approvalFailureMessage(
  reason: "corrupt" | "write_failed" | "trust_unknown" | "project_untrusted",
): string {
  switch (reason) {
    case "corrupt":
      return "⚠️ Approval could not be saved — the settings file is unreadable/corrupt (nothing was overwritten). This approval is one-time; repair the file to persist approvals.";
    case "write_failed":
      return "⚠️ Approval could not be saved — writing the settings file failed (permissions/disk?). This approval is one-time; check the enforcement log for details.";
    case "trust_unknown":
      return "⚠️ Approval could not be saved — the project settings file's trust could not be verified (git check failed). This approval is one-time; retry once git is available so it can be stored safely.";
    case "project_untrusted":
      return '⚠️ Approval could not be saved to the project — its settings file is not trustable (git-tracked or symlinked). Choose "everywhere" to store the approval globally, or run once.';
  }
}

async function notifyApprovalResults(failed: number, ui?: BashPolicyUi | null): Promise<void> {
  if (failed > 0) {
    await ui?.notify(
      `⚠️ ${failed} approval${failed > 1 ? "s" : ""} could not be saved — treated as run-once (see the enforcement log for the reason).`,
      "warning",
    );
  }
}

async function handleCommitTrailer(
  command: string,
  cmdRef: MutableCommand,
  input: BashPolicyInput,
  gitCwd: string,
): Promise<EnforcementResult> {
  // A placeholder trailer is REFUSED, never rewritten: the hook cannot safely tell
  // command text from message prose, and rewriting the wrong span corrupts a message
  // or edits an unrelated command (Qodo, PR #1004).
  const placeholder = findPlaceholderTrailer(command);
  if (placeholder) {
    return {
      block: true,
      reason:
        `⛔ Commit refused: the trailer carries an unresolved placeholder (${placeholder}). ` +
        `Write \`TRAILER: PI (${resolveCommitTrailerModelId(input.ctxModelId)})\` instead of a MODEL/$PI_MODEL placeholder ` +
        "and re-run the commit.",
    };
  }

  const trailerSetting = getSetting(gitCwd, "commit_trailer");
  if (typeof trailerSetting !== "string") return undefined;

  const modelId = resolveCommitTrailerModelId(input.ctxModelId);

  let trailerName: string;

  if (trailerSetting.includes(",")) {
    const options = trailerSetting
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (options.length === 0) {
      return {
        block: true,
        reason: `⛔ Malformed commit_trailer setting: "${trailerSetting.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}" — no valid trailer names found. Fix the setting in .pi/pi-config-settings.json or PI_COMMIT_TRAILER env var.`,
      };
    }
    const cached = input.trailerSelection?.get() ?? null;
    if (options.length === 1) {
      trailerName = options[0];
    } else if (cached && options.includes(cached)) {
      trailerName = cached;
    } else if (!input.ui) {
      trailerName = options[0];
    } else {
      const selected = await input.ui.select("Select commit trailer:", options);
      if (!selected || !options.includes(selected)) {
        return {
          block: true,
          reason: "Commit trailer selection cancelled by user.",
        };
      }
      trailerName = selected;
      input.trailerSelection?.set(selected);
    }
  } else {
    trailerName = trailerSetting;
  }

  const injected = injectCommitTrailer(cmdRef.current, trailerName, modelId);
  if (injected !== null) {
    cmdRef.current = injected;
    cmdRef.modified = true;
    return undefined;
  }

  const messageSpecs = commitMessageSpecs(command, input.cwd);
  let unverified = messageSpecs.length === 0;
  for (const spec of messageSpecs) {
    if (spec.kind === "inline") {
      unverified = true;
      continue;
    }
    if (spec.kind === "opaque-file") {
      return {
        block: true,
        reason:
          `⛔ Commit refused: the \`-F\` message file path is opaque and cannot be resolved or verified, ` +
          `so the \`${trailerName}\` trailer cannot be checked. Write the message to a literal readable file path with \`${trailerName}: PI (${modelId})\` in it, then re-run the commit.`,
      };
    }
    const fileMessage = spec.path;
    const candidatePaths = [
      ...new Set(
        [
          fileMessage,
          spec.rawOperand,
          path.relative(input.cwd, fileMessage),
          path.relative(spec.cwd, fileMessage),
        ].filter((p) => p && p !== "."),
      ),
    ];
    const maskedCommand = maskQuotedRegions(command);
    if (candidatePaths.some((p) => bashWritesToPath(command, maskedCommand, escapeRegExp(p)))) {
      enfLog.warn("commit_trailer: message file is written by the same command", fileMessage);
      return {
        block: true,
        reason:
          `⛔ Commit refused: this command writes ${fileMessage} and commits it in the same call, ` +
          "so the message cannot be verified before it is read. Write the message (with the trailer) in one call and commit in the next.",
      };
    }
    const state = messageFileTrailerState(fileMessage, trailerName, (p) => readFileSync(p, "utf8"));
    if (state === "has") {
      enfLog.debug("commit_trailer: message file already carries the trailer", fileMessage);
      continue;
    }
    if (state === "missing") {
      const quotedFile = `'${escapeForSingleQuote(fileMessage)}'`;
      return {
        block: true,
        reason:
          `⛔ Commit refused: the message file ${fileMessage} has no \`${trailerName}\` trailer. ` +
          `Append it with the real id — \`printf '\\n\\n${trailerName}: PI (%s)\\n' "$PI_MODEL" >> ${quotedFile}\` — then re-run the commit.`,
      };
    }
    return {
      block: true,
      reason:
        `⛔ Commit refused: cannot read the message file ${fileMessage}, so the \`${trailerName}\` ` +
        "trailer cannot be verified. Write the message to a file the hook can read, with the trailer in it, then re-run the commit.",
    };
  }
  if (!unverified) return undefined;
  if (!commandHasTrailerByName(stripUnquotedShellComments(command), trailerName)) {
    return {
      block: true,
      reason:
        `⛔ Commit refused: no \`${trailerName}\` trailer found and this commit shape is opaque to the hook ` +
        `(the message is built in a way it cannot inspect). Add \`${trailerName}: PI (${modelId})\` to the message ` +
        `yourself — e.g. \`printf '\\n\\n${trailerName}: PI (%s)\\n' "$PI_MODEL" >> <file>\` for \`-F <file>\` — then re-run the commit.`,
    };
  }
  return undefined;
}

/** Git protection: worktrees, add ., gitignored files, hooks, protected branches, trailers, DCO */
async function checkGitProtection(
  command: string,
  cmdRef: MutableCommand,
  input: BashPolicyInput,
  gitCwd: string,
  prefetchedBranch?: string | null,
): Promise<EnforcementResult> {
  if (!/\bgit\b/.test(command)) return undefined;
  if (!isGitRepo(gitCwd)) return undefined;

  if (getSetting(gitCwd, "use_worktrees")) {
    const blockedCheckout = realGitSub(command, "checkout") && !/\bgit\b.*\bcheckout\b.*\s--\s/.test(command);
    const blockedSwitch = !blockedCheckout && realGitSub(command, "switch");
    if (blockedCheckout || blockedSwitch) {
      const mb = getMainBranch(gitCwd) || "main";
      const hint = `Use: git worktree add .worktrees/<name> -b <branch> ${mb}`;
      return {
        block: true,
        reason: `⛔ git ${blockedCheckout ? "checkout" : "switch"} blocked — use_worktrees is enabled. ${hint}`,
      };
    }
  }

  if (hasGitAddBulk(command)) {
    return {
      block: true,
      reason: "⛔ 'git add .' / 'git add -A' forbidden. Stage specific files.",
    };
  }

  if (hasGitAddForce(command)) {
    return {
      block: true,
      reason: "⛔ 'git add -f/--force' forbidden. It bypasses .gitignore and stages ignored files.",
    };
  }

  {
    const staged = gitAddPathspecs(command);
    if (staged && staged.length === 1) {
      const checkIgnored = runGit(["check-ignore", "-q", staged[0]], gitCwd);
      if (checkIgnored.code === 0) {
        return {
          block: true,
          reason: `⛔ '${staged[0]}' is in .gitignore. Do not stage ignored files.`,
        };
      }
    } else if (staged && staged.length > 1) {
      const batched = runGit(["check-ignore", "--stdin", "-z"], gitCwd, `${staged.join("\0")}\0`);
      const firstIgnored = batched.stdout.split("\0").find(Boolean);
      if (firstIgnored) {
        return {
          block: true,
          reason: `⛔ '${firstIgnored}' is in .gitignore. Do not stage ignored files.`,
        };
      }
      if (batched.code !== 0 && batched.code !== 1) {
        for (const file of staged) {
          const checkIgnored = runGit(["check-ignore", "-q", file], gitCwd);
          if (checkIgnored.code === 0) {
            return {
              block: true,
              reason: `⛔ '${file}' is in .gitignore. Do not stage ignored files.`,
            };
          }
        }
      }
    }
  }

  if (command.includes("core.hooksPath=/dev/null") || command.includes('core.hooksPath="/dev/null"')) {
    return {
      block: true,
      reason: "⛔ Bypassing git hooks via core.hooksPath=/dev/null is forbidden.",
    };
  }

  const isCommit = realGitSub(command, "commit");
  if (
    isCommit &&
    gitSubArgRegions(command, "commit").some((r) => /(?:^|\s)--no-verify\b/.test(stripQuotedSpans(r)))
  ) {
    return {
      block: true,
      reason: "⛔ --no-verify forbidden. Pre-commit hooks must run.",
    };
  }

  const isPush = realGitSub(command, "push");
  if (!isCommit && !isPush) return undefined;

  const branch = prefetchedBranch !== undefined ? prefetchedBranch : getCurrentBranch(gitCwd);
  const mainBranch = getMainBranch(gitCwd);
  const protectedBranches = getProtectedBranches(gitCwd);

  if (isCommit) {
    if (!branch) {
      return {
        block: true,
        reason: "⛔ Detached HEAD. Create a branch first: git checkout -b my-branch",
      };
    }
    if (protectedBranches.has(branch) && !getSetting(gitCwd, "allow_push_to_protected_branches")) {
      return {
        block: true,
        reason: `⛔ Cannot commit to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git commit in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
      };
    }

    const pr = getPrMergeStatus(branch, gitCwd);
    if (pr.merged) {
      return {
        block: true,
        reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch from ${mainBranch || "main"}.`,
      };
    }

    if (command.includes("--amend") && isBranchAhead(gitCwd)) return undefined;

    if (mainBranch && isBranchMerged(branch, mainBranch, gitCwd)) {
      return {
        block: true,
        reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
      };
    }

    const trailerResult = await handleCommitTrailer(command, cmdRef, input, gitCwd);
    if (trailerResult) return trailerResult;

    if (getSetting(gitCwd, "dco")) {
      const signed = injectSignoff(cmdRef.current);
      if (signed !== cmdRef.current) {
        enfLog.debug("DCO: injected --signoff into real git commit invocation");
        cmdRef.current = signed;
        cmdRef.modified = true;
      }
    }
  }

  if (isPush) {
    if (!getSetting(gitCwd, "allow_push_to_protected_branches")) {
      if (branch && protectedBranches.has(branch)) {
        return {
          block: true,
          reason: `⛔ Cannot push to '${branch}' (protected). Create a feature branch.\nHint: If you're combining git checkout + git push in one bash call, split them into SEPARATE bash calls. Branch is checked before execution.`,
        };
      }
      const pb = pushTargetsProtectedBranch(command, protectedBranches);
      if (pb) {
        return {
          block: true,
          reason: `⛔ Cannot push to '${pb}' (protected). Create a feature branch.`,
        };
      }
    }
    if (branch) {
      const pr = getPrMergeStatus(branch, gitCwd);
      if (pr.merged) {
        return {
          block: true,
          reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch.`,
        };
      }
      if (mainBranch && isBranchMerged(branch, mainBranch, gitCwd)) {
        return {
          block: true,
          reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.`,
        };
      }
    }
  }

  return undefined;
}

/** Dangerous command evaluation + interactive UI / allowlist / session-grant loop. */
async function checkDangerousCommands(
  command: string,
  cwd: string,
  sessionId: string | null,
  ui?: BashPolicyUi | null,
): Promise<EnforcementResult> {
  const statements = splitBashStatements(command);
  const hasDangerous = statements.some((stmt) => {
    if (isReadOnlyStatement(stmt)) return false;
    if (isNoexecSyntaxCheck(stmt)) {
      enfLog.info("dangerous_gate_noexec_syntax_check", {
        statementHash: createHash("sha256").update(stmt).digest("hex").slice(0, 12),
      });
      return false;
    }
    return DANGEROUS.some((p) => p.test(stmt));
  });
  if (!hasDangerous) return undefined;

  const relativeRm = statements
    .map((stmt) => ({
      stmt,
      target: isReadOnlyStatement(stmt) ? null : relativeRecursiveRmTarget(stmt),
    }))
    .find((r) => r.target !== null);
  if (relativeRm && relativeRm.target !== null) {
    enfLog.warn("recursive_rm_relative_path_blocked", { target: relativeRm.target });
    const nonLiteral = /[$`*?[\]]/.test(relativeRm.target);
    const rewrite = nonLiteral
      ? `Rewrite with a LITERAL full path (no variables or globs — an approval must bind to ` +
        `one concrete folder) and re-run.`
      : `Rewrite as rm -rf ${resolve(resolveEffectiveCwd(command, cwd), relativeRm.target)} (full path) and re-run. `;
    return {
      block: true,
      reason:
        `Blocked: recursive rm must use ABSOLUTE paths — "${relativeRm.stmt.trim()}" targets ` +
        `"${relativeRm.target}", which is ${nonLiteral ? "not a literal path" : "relative"}. ` +
        `A persistent "always allow" stores the statement text, so a relative ` +
        `target would approve the same text in ANY directory. ${rewrite} ` +
        `Do NOT bypass with an equivalent command (find -delete, git clean, perl, python ` +
        `os.remove). Stop and report this block to the user if a rewrite is not possible.`,
    };
  }

  const allRmInTmp = statements
    .filter((stmt) => DANGEROUS.some((p) => p.test(stmt)) && !isReadOnlyStatement(stmt) && !isNoexecSyntaxCheck(stmt))
    .every((stmt) => isRmInProjectTmp(stmt, cwd));
  if (allRmInTmp) {
    enfLog.info("dangerous_gate_rm_scratch_exempt", {
      statements: statements.length,
      statementHash: createHash("sha256").update(statements.join("\n")).digest("hex").slice(0, 12),
    });
    return undefined;
  }

  const dangerousStmts = [
    ...new Set(
      statements
        .filter((stmt) => DANGEROUS.some((p) => p.test(stmt)) && !isReadOnlyStatement(stmt) && !isNoexecSyntaxCheck(stmt))
        .map((stmt) => normalizeDangerousStatement(stmt)),
    ),
  ];
  const unapproved: string[] = [];
  const allowlists = loadDangerousAllowlists(cwd);
  for (const stmt of dangerousStmts) {
    if (isStdinFedShellStatement(stmt)) {
      unapproved.push(stmt);
      continue;
    }
    if (hasDangerousSessionApproval(sessionId, stmt)) {
      enfLog.info("dangerous_command_allowed_session", {
        dangerousPattern: DANGEROUS.filter((p) => p.test(stmt))
          .map((p) => dangerousPatternLabel(p))
          .join(", "),
        hashPrefix: dangerousCommandHash(stmt).slice(0, 12),
        persisted: false,
      });
      continue;
    }
    const allowMatch = matchDangerousAllowlist(allowlists, stmt);
    if (!allowMatch) {
      unapproved.push(stmt);
      continue;
    }
    enfLog.warn("dangerous_command_allowlisted", {
      dangerousPattern: String(DANGEROUS.find((p) => p.test(stmt)) ?? "unknown"),
      entryHashPrefix: dangerousCommandHash(allowMatch.entry).slice(0, 12),
      source: allowMatch.source,
    });
  }
  if (unapproved.length === 0) return undefined;

  if (!ui) {
    return {
      block: true,
      reason:
        "Dangerous command blocked (no UI for confirmation). Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user.",
    };
  }

  const projectTrustable = projectSettingsTrust(cwd) === "untracked";
  const decide = async (remaining: string[]): Promise<EnforcementResult | undefined> => {
    const list = remaining
      .map((stmt) => {
        const rules = dangerousPatternExplanations(DANGEROUS.filter((p) => p.test(stmt)))
          .map(
            (e) =>
              `    ↳ ${e.why}\n      · can be lost: ${e.consequence}\n      · approval covers: ${e.grants}`,
          )
          .join("\n");
        const stdinFed = isStdinFedShellStatement(stmt)
          ? "\n    ↳ reads its script from stdin — run-once only, never approvable beyond this run"
          : "";
        return `  ${stmt}\n${rules}${stdinFed}`;
      })
      .join("\n");
    const scopeNote = projectTrustable
      ? ""
      : "\n\nℹ️ The project settings file is not trustable for approvals (git-tracked or\nsymlinked) — persistent approvals can only be stored globally.";
    const persistable = remaining.filter((stmt) => !isStdinFedShellStatement(stmt));
    const offeredScopes = dangerousApprovalScopes({
      approvableBeyondRun: persistable.length > 0,
      projectTrustable,
      sessionAvailable: sessionId !== null,
    });
    const grants = offeredScopes.map((s) => `  • ${DANGEROUS_SCOPE_GRANTS[s]}`).join("\n");
    const seen = new Map<string, number>();
    const labelFor = (stmt: string): string => {
      const base = stmt.length > 60 ? `${stmt.slice(0, 57)}…` : stmt;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base} (#${n})`;
    };
    const labeled = persistable.map((stmt) => ({ stmt, label: labelFor(stmt) }));
    const options = [
      "Yes — run once",
      ...labeled.flatMap(({ label }) => [
        ...(offeredScopes.includes("session") ? [`Allow for this session: ${label}`] : []),
        ...(projectTrustable ? [`Always allow (this project): ${label}`] : []),
        `Always allow (everywhere): ${label}`,
      ]),
      ...(persistable.length > 1
        ? [
            ...(projectTrustable ? ["Always allow all of the above (this project)"] : []),
            "Always allow all of the above (everywhere)",
          ]
        : []),
      "No",
    ];
    const promptTitle = `⚠️ Dangerous statement${remaining.length > 1 ? "s" : ""} (of the full command):\n\n${list}${scopeNote}\n\nWhat each answer grants:\n${grants}\n\nAllow?`;
    const ok = await ui.select(promptTitle, options);
    if (ok === "No" || ok === undefined) {
      return {
        block: true,
        reason:
          "Blocked by user. Do NOT retry with an equivalent command (e.g., find -delete, perl, python os.remove). Stop and report this block to the user.",
      };
    }
    if (ok === "Yes — run once" || ok.startsWith("Always allow all of the above")) {
      if (ok.startsWith("Always allow all of the above")) {
        const scope = ok.endsWith("(everywhere)") ? "global" : "project";
        const results = persistable.map((stmt) => addDangerousAllowlistEntry(cwd, stmt, scope));
        const saved = results.filter((r) => r.ok);
        const failed = results.length - saved.length;
        const scopes = [...new Set(saved.map((r) => (r.ok ? r.scope : "")))];
        enfLog.info("dangerous_command_allowlist_entry_added", {
          count: saved.length,
          failed,
          storedIn: scopes.length === 1 ? `${scopes[0]} settings (dangerous_command_allowlist)` : scopes.join("+"),
        });
        await notifyApprovalResults(failed, ui);
      }
      return undefined;
    }
    if (ok.startsWith("Allow for this session: ")) {
      const chosen = labeled.find(({ label }) => ok === `Allow for this session: ${label}`)?.stmt;
      if (chosen !== undefined) {
        grantDangerousSessionApproval(sessionId, chosen);
        enfLog.info("dangerous_command_session_approval_granted", {
          dangerousPattern: DANGEROUS.filter((p) => p.test(chosen))
            .map((p) => dangerousPatternLabel(p))
            .join(", "),
          hashPrefix: dangerousCommandHash(chosen).slice(0, 12),
          persisted: false,
        });
        const still = remaining.filter((s) => s !== chosen);
        if (still.length === 0) return undefined;
        return decide(still);
      }
    }
    if (ok.startsWith("Always allow (this project): ") || ok.startsWith("Always allow (everywhere): ")) {
      const scope = ok.startsWith("Always allow (everywhere): ") ? "global" : "project";
      const chosen = labeled.find(
        ({ label }) => ok === `Always allow (${scope === "global" ? "everywhere" : "this project"}): ${label}`,
      )?.stmt;
      if (chosen !== undefined) {
        const result = addDangerousAllowlistEntry(cwd, chosen, scope);
        if (result.ok) {
          enfLog.info("dangerous_command_allowlist_entry_added", {
            dangerousPattern: dangerousPatternLabel(DANGEROUS.find((p) => p.test(chosen)) ?? /./),
            hashPrefix: dangerousCommandHash(chosen).slice(0, 12),
            storedIn: `${result.scope} settings (dangerous_command_allowlist)`,
          });
        } else {
          enfLog.warn("dangerous_allowlist_entry_add_failed", {
            reason: result.reason,
            hashPrefix: dangerousCommandHash(chosen).slice(0, 12),
          });
          await ui.notify(approvalFailureMessage(result.reason), "warning");
        }
        const still = remaining.filter((s) => s !== chosen);
        if (still.length === 0) return undefined;
        return decide(still);
      }
    }
    return undefined;
  };
  return decide(unapproved);
}

/**
 * Evaluate a bash command against the complete enforcement policy pipeline.
 * Single deep entry point called by the thin `enforcement.ts` hook adapter and
 * directly by in-process policy tests.
 */
export async function evaluateBashPolicy(input: BashPolicyInput): Promise<BashPolicyDecision> {
  const command = input.command;
  const cmdLower = command.trim().toLowerCase();
  const cmdRef: MutableCommand = { current: command, modified: false };
  let stripTimeout = false;

  const isSubagentChild = input.isSubagentChild ?? process.env.PI_SUBAGENT_CHILD === "1";
  const agentName = input.agentName !== undefined ? input.agentName : process.env.PI_AGENT_NAME;
  const sessionId = input.sessionId ?? null;

  // Block bash commands tampering with review state storage (legacy pi-config-review-state
  // files, SQLite .pi/data/state.db / WAL / SHM / kv_state, or .pi/run/review-tracked —
  // including globs, brace expansions, shell variable indirection, nested `-c`/`eval`
  // scripts, and adjacent redirects like `>.pi/data/state.db`) while allowing inert mentions
  // and ordinary file commands (e.g. `grep kv_state src/`, `ls state.db`, `rm harmless `).
  if (getSetting(input.cwd, "review_loop_enforcement")) {
    const stateDbPathRe =
      /(?:^|[\s"'`=:(/<>|;&])\.pi\/data\/state\.d(?:b(?:-wal|-shm)?|[?*[{][^\s"'`;|&)]*)(?=$|[\s"'`;|&){*?[\]\\])/i;
    const piDirTargetRe =
      /(?:^|[\s"'`=:(/<>|;&])\.pi(?:\/(?:data|run))?\/?(?=$|[\s"'`;|&)])/i;
    const piProtectedFileRe =
      /(?:^|[\s"'`=:(/<>|;&])\.pi\/(?:data\/(?:state\.[^\s"'`;|&)]*|[^\s"'`;|&)]*[*?[{][^\s"'`;|&)]*)|run\/(?:review-tracked[^\s"'`;|&)]*|[^\s"'`;|&)]*[*?[{][^\s"'`;|&)]*))(?=$|[\s"'`;|&){*?[\]\\])/i;
    const adjacentRedirectRe = /(?:>>?|>\|)\s*["']?[^\s"'`;|&)]*\.pi\/(?:data\/state\.d|run\/review-tracked)/i;
    const sqliteInvokeRe = /\b(?:node:sqlite|databasesync|sqlite3|better-sqlite3)\b/i;
    const fileMutateCmds = new Set(["rm", "unlink", "mv", "cp", "truncate", "dd", "shred", "install", "ln"]);

    const stripOuterQuotes = (s: string): string =>
      (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("\"") && s.endsWith("\""))
        ? s.slice(1, -1)
        : s;

    // Normalize repeated `/` and `.` / `..` segments so paths like `.pi/data//state.db`
    // or `./.pi/./data/../data/state.db` match protected-path checks reliably.
    const normalizePathOperand = (raw: string): string => {
      const unquoted = stripOuterQuotes(raw);
      if (!unquoted.includes("/")) return unquoted;
      return path.posix.normalize(unquoted.replace(/\/+/g, "/"));
    };

    const normalizeSlashesInText = (text: string): string =>
      text.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/)/g, "");

    const targetsProtectedPath = (text: string): boolean => {
      const normalized = normalizeSlashesInText(text);
      return (
        stateDbPathRe.test(normalized) ||
        piDirTargetRe.test(normalized) ||
        piProtectedFileRe.test(normalized)
      );
    };

    const expandVars = (text: string, vars: Map<string, string>): string => {
      if (vars.size === 0 || !text.includes("$")) return text;
      return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, a, b) => {
        const name = (a ?? b) as string;
        return vars.has(name) ? vars.get(name)! : m;
      });
    };

    const recordAssignments = (tokens: string[], vars: Map<string, string>): boolean => {
      let sawProtected = false;
      for (const tok of tokens) {
        if (tok === "export" || tok === "local" || tok === "readonly" || tok === "declare" || tok === "typeset") {
          continue;
        }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
        if (!m) break;
        const val = expandVars(stripOuterQuotes(m[2]!), vars);
        vars.set(m[1]!, val);
        if (targetsProtectedPath(val) || /\.pi(?:\/(?:data|run))?\b/i.test(val)) {
          sawProtected = true;
        }
      }
      return sawProtected;
    };

    const extractNestedShellScripts = (tokens: string[], cmdIdx: number, cmdWord: string): string[] => {
      const scripts: string[] = [];
      if (cmdWord === "eval") {
        const evalArgs: string[] = [];
        for (let i = cmdIdx + 1; i < tokens.length; i++) {
          const tok = tokens[i]!;
          if (evalArgs.length === 0 && tok === "--") continue;
          evalArgs.push(stripOuterQuotes(tok));
        }
        if (evalArgs.length > 0) scripts.push(evalArgs.join(" "));
        return scripts;
      }
      for (let i = cmdIdx + 1; i < tokens.length - 1; i++) {
        const tok = tokens[i]!;
        if (/^-[a-zA-Z]*c$/.test(tok)) {
          const arg = stripOuterQuotes(tokens[i + 1]!);
          if (arg) scripts.push(arg);
        }
      }
      return scripts;
    };

    const hasSqliteTamperInText = (text: string): boolean =>
      sqliteInvokeRe.test(text) &&
      (/\bkv_state\b/i.test(text) ||
        stateDbPathRe.test(text) ||
        (/\.pi\/data\b/i.test(text) && !/\b(?:pr-)?reviews\.db\b/i.test(text)));

    const inspectScriptForTamper = (script: string, parentVars: Map<string, string>, depth = 0): boolean => {
      if (depth > 3) return false;
      if (script.toLowerCase().includes("pi-config-review-state")) return true;
      const vars = new Map(parentVars);
      let sawProtectedAssignment = false;

      for (const seg of unquotedSegments(script)) {
        const rawTokens = tokenize(seg.text);
        if (rawTokens.length === 0) continue;
        if (recordAssignments(rawTokens, vars)) {
          sawProtectedAssignment = true;
        }

        const expandedSeg = expandVars(seg.text, vars);
        const normalizedSeg = normalizeSlashesInText(expandedSeg);
        const maskedSeg = maskQuotedRegions(normalizedSeg);
        if (
          adjacentRedirectRe.test(maskedSeg) ||
          (targetsProtectedPath(normalizedSeg) &&
            bashWritesToPath(
              normalizedSeg,
              maskedSeg,
              "\\.pi/(?:data/state\\.d(?:b(?:-wal|-shm)?|[?*[{][^\\s\"'`;|&)]*)|run/review-tracked)",
            )) ||
          hasSqliteTamperInText(normalizedSeg)
        ) {
          return true;
        }

        const expandedTokens = tokenize(expandedSeg);
        if (expandedTokens.length === 0) continue;
        const cmdIdx = skipToCommandWord(expandedTokens);
        const cmdWord = basename(expandedTokens[cmdIdx] ?? "").toLowerCase();

        if (fileMutateCmds.has(cmdWord)) {
          if (
            targetsProtectedPath(normalizedSeg) ||
            expandedTokens
              .slice(cmdIdx + 1)
              .some((tok) => !tok.startsWith("-") && targetsProtectedPath(normalizePathOperand(tok)))
          ) {
            return true;
          }
          // Fail closed if an earlier segment assigned a protected path to a variable and
          // this mutating command still has an unresolved variable operand (`$foo`/`${foo}`).
          if (sawProtectedAssignment && /\$(?:\{[A-Za-z_]|[A-Za-z_])/.test(expandedSeg)) {
            return true;
          }
        }

        if (cmdWord === "eval" || runsNestedShell(expandedTokens)) {
          for (const innerScript of extractNestedShellScripts(expandedTokens, cmdIdx, cmdWord)) {
            if (inspectScriptForTamper(innerScript, vars, depth + 1)) return true;
          }
        }
      }
      return false;
    };

    if (inspectScriptForTamper(command, new Map())) {
      enfLog.warn("review_state_bash_blocked");
      return {
        action: "block",
        reason:
          "\u26d4 Bash command targeting review state storage (pi-config-review-state / state.db) blocked. The review state is managed exclusively by the enforcement system.",
      };
    }
  }

  // Unconditional fail-closed protection for:
  // 1. `.approval-hmac-key` (never readable or writable from shell)
  // 2. `.pi/data/state.db*` & `restricted_folder_approvals` (persistent grants & state DB,
  //    protected regardless of `review_loop_enforcement`)
  // 3. `.pi/pi-config-settings*` / `~/.pi/pi-config-settings*` (carries `dangerous_command_allowlist`
  //    and `restricted_folders` — protected even when assembled dynamically via shell variables,
  //    adjacent quotes, string concatenation, globs, or inline scripts)
  {
    const stripOuterQuotesSimple = (s: string): string =>
      (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("\"") && s.endsWith("\""))
        ? s.slice(1, -1)
        : s;

    const decodeSimpleEscapes = (text: string): string =>
      text
        .replace(/\\0([0-7]{2,3})/g, (_, oct: string) => {
          const code = Number.parseInt(oct, 8);
          return code >= 32 && code <= 126 ? String.fromCharCode(code) : _;
        })
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => {
          const code = Number.parseInt(hex, 16);
          return code >= 32 && code <= 126 ? String.fromCharCode(code) : _;
        })
        .replace(/\\u00([0-9a-fA-F]{2})/gi, (_, hex: string) => {
          const code = Number.parseInt(hex, 16);
          return code >= 32 && code <= 126 ? String.fromCharCode(code) : _;
        });

    const unwrapShellArgQuotes = (s: string): string => {
      if (s.startsWith("$'") && s.endsWith("'") && s.length >= 3) {
        return decodeAnsiCEscapes(s.slice(2, -1));
      }
      if (s.startsWith("$\"") && s.endsWith("\"") && s.length >= 3) {
        return s.slice(2, -1);
      }
      return stripOuterQuotesSimple(s);
    };

    const collapseFragments = (text: string): string =>
      decodeSimpleEscapes(text)
        // Shell adjacent quotes & empty-quote breaks: "pi-""config" / 'pi-''config' / .pi/"pi-config""-settings.json"
        .replace(/""|''/g, "")
        // Script string concatenation: "pi-" + "config" / 'state.' + 'db' / "pi-" . "config"
        .replace(/"\s*[+.]\s*"/g, "")
        .replace(/'\s*[+.]\s*'/g, "")
        // Inline quoted segments glued onto paths: .pi/"pi-config-settings.json" -> .pi/pi-config-settings.json
        .replace(/([/.~-])["']([^"'\s;|&()]+)["']/g, "$1$2")
        .replace(/["']([^"'\s;|&()]+)["']([/.~-])/g, "$1$2")
        // Repeated slashes & /./ normalization
        .replace(/\/{2,}/g, "/")
        .replace(/\/\.(?=\/)/g, "");

    const expandShellVars = (text: string, vars: Map<string, string>): string => {
      if (vars.size === 0 || !text.includes("$")) return text;
      return text.replace(
        /\$\{!([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])\}|\$([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*])/g,
        (m, indirect, a, b) => {
          if (indirect) {
            const targetName = vars.get(indirect as string);
            if (targetName && vars.has(targetName)) return vars.get(targetName)!;
            return m;
          }
          const name = (a ?? b) as string;
          return vars.has(name) ? vars.get(name)! : m;
        },
      );
    };

    const unresolvedVarOrPositionalRe = /\$(?:\{[^}]+\}|[A-Za-z_0-9@*!])/;
    const hmacKeyRe = /(?:\.|\b)approval[-_]?hmac[-_]?key\b/i;
    const dynamicPiAgentAccessRe =
      /(?:~|\$HOME|\$\{HOME\}|\/[^\s"'`;|&)]*)\/\.pi\/agent\/[^\s"'`;|&)]*["']?(?:\$|[*?{`])/i;
    const inlineRuntimeDynamicPiAgentRe =
      /(?:\.pi\/agent\/?["'`]\s*\)?\s*(?:[+./,%]|\.\s*format\b)|["'`]\.pi["'`]\s*,\s*["'`]agent["'`]|(?:readdir|listdir|scandir|glob|iglob|walk|iterdir)\w*\s*\([^)]*\.pi\/agent)/i;
    const settingsPathRe =
      /(?:^|[\s"'`=:(/<>|;&,])(?:~\/|\/[^\s"'`;|&)]*\/|\.?\/)?\.pi\/(?:pi-config-settings[^\s"'`;|&)]*|pi-config-[^\s"'`;|&)]*[*?[{][^\s"'`;|&)]*|\*[^\s"'`;|&)]*settings[^\s"'`;|&)]*)/i;
    const stateDbUncondRe =
      /(?:^|[\s"'`=:(/<>|;&,])(?:~\/|\/[^\s"'`;|&)]*\/|\.?\/)?\.pi\/data\/state\.d(?:b(?:-wal|-shm)?|[?*[{][^\s"'`;|&)]*)/i;
    const sqliteEngineRe = /\b(?:node:sqlite|databasesync|sqlite3|better-sqlite3)\b/i;
    const scriptWriteRe = /\b(?:writeFileSync|writeFile|createWriteStream|open\s*\(|Path\s*\(|dump\s*\(|unlinkSync|rmSync|renameSync|truncateSync|shutil|os\.remove|os\.replace)\b/i;
    const fileMutateOps = new Set(["rm", "unlink", "mv", "cp", "truncate", "dd", "shred", "install", "ln", "sed", "perl", "ruby"]);
    const inlineRuntimeOps = new Set(["python", "python3", "node", "nodejs", "bun", "deno", "tsx", "perl", "ruby"]);

    const SQLITE_SAFE_FLAGS_NO_ARG = new Set([
      "-readonly",
      "-json",
      "-csv",
      "-line",
      "-list",
      "-column",
      "-header",
      "-noheader",
      "-box",
      "-markdown",
      "-table",
      "-batch",
      "-bail",
      "-quote",
      "-ascii",
      "-html",
      "-tabs",
    ]);
    const SQLITE_SAFE_FLAGS_WITH_ARG = new Set(["-separator", "-newline", "-nullvalue", "-timeout"]);
    const SQLITE_MUTATING_SQL_RE =
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ANALYZE)\b|\bPRAGMA\b[^;]*=|\b(?:writefile|edit|load_extension|fts3_tokenizer)\s*\(/i;
    const SQLITE_READONLY_SQL_START_RE = /^\s*(?:SELECT\b|EXPLAIN\s+(?:QUERY\s+PLAN\s+)?SELECT\b|\.tables\b|\.schema\b)/i;

    /**
     * Strictly verify whether a `sqlite3` CLI segment is a read-only inspection query
     * (e.g. `sqlite3 .pi/data/state.db "SELECT payload FROM kv_state WHERE ..."`).
     * Any write, multi-statement `;`, dynamic `$`/backtick, stdin-only mode, `-cmd`/`-init`,
     * redirection, or non-SELECT query returns false (fail closed).
     */
    const isVerifiablyReadOnlySqliteSeg = (
      expandedTokens: string[],
      cmdIdx: number,
      maskedSeg: string,
    ): boolean => {
      const cmdWord = basename(expandedTokens[cmdIdx] ?? "").toLowerCase();
      if (cmdWord !== "sqlite3") return false;
      if (/[<>]/.test(maskedSeg)) return false;

      const positional: string[] = [];
      for (let i = cmdIdx + 1; i < expandedTokens.length; i++) {
        const tok = expandedTokens[i]!;
        if (tok === "--") {
          for (let j = i + 1; j < expandedTokens.length; j++) positional.push(expandedTokens[j]!);
          break;
        }
        if (tok.startsWith("-")) {
          if (SQLITE_SAFE_FLAGS_NO_ARG.has(tok)) continue;
          if (SQLITE_SAFE_FLAGS_WITH_ARG.has(tok)) {
            i++;
            continue;
          }
          // Reject -cmd, -init, or any unknown flag (fail closed).
          return false;
        }
        positional.push(tok);
      }
      // Require explicit <dbPath> and <sql> arguments (reject stdin-driven `sqlite3 db`).
      if (positional.length < 2) return false;
      for (const rawSql of positional.slice(1)) {
        const sql = stripOuterQuotesSimple(rawSql).trim();
        if (!sql) return false;
        if (/[;`$]|--|\/\*/.test(sql)) return false;
        if (SQLITE_MUTATING_SQL_RE.test(sql)) return false;
        if (!SQLITE_READONLY_SQL_START_RE.test(sql)) return false;
      }
      return true;
    };

    /**
     * Strip closed quoted heredoc bodies (`<<'EOF'`, `<<-'EOF'`, `<<"EOF"`, `<<-"EOF"`)
     * where bash performs zero expansion, while keeping unquoted (`<<EOF`) and unclosed
     * heredoc bodies verbatim (fail-closed). Tracks double-quote and `$(...)` nesting so
     * `"$(cat <<'EOF'\n...\nEOF\n)"` works while literal `<<'EOF'` inside plain `"..."`
     * cannot hide an active `$(...)` substitution.
     */
    const extractQuotedHeredocs = (
      input: string,
    ): { stripped: string; quotedBodies: string[] } => {
      if (!input.includes("<<")) return { stripped: input, quotedBodies: [] };
      const quotedBodies: string[] = [];
      const pending: { delim: string; expand: boolean; stripTabs: boolean }[] = [];
      type Frame = { kind: "double" } | { kind: "subst"; parenDepth: number };
      const stack: Frame[] = [];
      let out = "";
      let i = 0;

      while (i < input.length) {
        const top = stack[stack.length - 1];
        const ch = input[i]!;

        if (top?.kind === "double") {
          if (ch === "\\" && i + 1 < input.length) {
            out += input.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (ch === "$" && input[i + 1] === "(") {
            stack.push({ kind: "subst", parenDepth: 1 });
            out += "$(";
            i += 2;
            continue;
          }
          if (ch === '"') stack.pop();
          out += ch;
          i++;
          continue;
        }

        if (ch === "\\" && i + 1 < input.length) {
          out += input.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === "#" && (i === 0 || /[\s;&|(]/.test(input[i - 1]!))) {
          const nl = input.indexOf("\n", i);
          if (nl === -1) {
            out += input.slice(i);
            break;
          }
          out += input.slice(i, nl);
          i = nl;
          continue;
        }
        if (ch === "'") {
          const close = input.indexOf("'", i + 1);
          if (close === -1) {
            out += input.slice(i);
            break;
          }
          out += input.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        if (ch === '"') {
          stack.push({ kind: "double" });
          out += ch;
          i++;
          continue;
        }
        if (ch === "$" && input[i + 1] === "(") {
          stack.push({ kind: "subst", parenDepth: 1 });
          out += "$(";
          i += 2;
          continue;
        }
        if (top?.kind === "subst") {
          if (ch === "(") {
            top.parenDepth++;
            out += ch;
            i++;
            continue;
          }
          if (ch === ")") {
            top.parenDepth--;
            if (top.parenDepth === 0) stack.pop();
            out += ch;
            i++;
            continue;
          }
        }
        if (ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
          const m = matchHeredocOpener(input.slice(i), "executable");
          if (m) {
            pending.push({ delim: m.delim, expand: m.expand, stripTabs: m.stripTabs });
            out += input.slice(i, i + m.length);
            i += m.length;
            continue;
          }
        }
        if (ch === "\n" && pending.length > 0) {
          const bodies: string[][] = pending.map(() => []);
          const { next, closed } = skipHeredocBody(input, i + 1, pending, {
            stripCr: true,
            onBodyLine: (line, hIdx) => bodies[hIdx]!.push(line),
          });
          if (!closed) {
            // Unclosed heredoc: fail closed by keeping remainder verbatim.
            out += input.slice(i);
            break;
          }
          out += "\n";
          for (let hIdx = 0; hIdx < pending.length; hIdx++) {
            const bodyText = bodies[hIdx]!.join("\n");
            if (pending[hIdx]!.expand) {
              out += `${bodyText}\n`;
            } else {
              quotedBodies.push(bodyText);
            }
          }
          pending.length = 0;
          i = next;
          continue;
        }
        out += ch;
        i++;
      }

      if (quotedBodies.length > 0) {
        enfLog.debug("extract_quoted_heredocs", "count", quotedBodies.length);
      }
      return { stripped: out, quotedBodies };
    };

    /**
     * Replace standalone single-quoted spans (`'...'` and `'\''`-chained literal words)
     * with `''` so inert Markdown prose (e.g. `'see \`~/.pi/agent/bin/pi\`'`) does not
     * trip dynamic shell-expansion guards. Double-quoted spans, glued single quotes
     * (e.g. `cat '/home/u/.pi/agent/'*`), and unterminated quotes stay verbatim (fail-closed).
     */
    const stripStandaloneSingleQuotes = (input: string): string => {
      if (!input.includes("'")) return input;
      type Frame = { kind: "double" } | { kind: "subst"; parenDepth: number };
      const stack: Frame[] = [];
      let out = "";
      let i = 0;

      while (i < input.length) {
        const top = stack[stack.length - 1];
        const ch = input[i]!;

        if (top?.kind === "double") {
          if (ch === "\\" && i + 1 < input.length) {
            out += input.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (ch === "$" && input[i + 1] === "(") {
            stack.push({ kind: "subst", parenDepth: 1 });
            out += "$(";
            i += 2;
            continue;
          }
          if (ch === '"') stack.pop();
          out += ch;
          i++;
          continue;
        }

        if (ch === "\\" && i + 1 < input.length) {
          out += input.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === "#" && (i === 0 || /[\s;&|(]/.test(input[i - 1]!))) {
          const nl = input.indexOf("\n", i);
          if (nl === -1) {
            out += input.slice(i);
            break;
          }
          out += input.slice(i, nl);
          i = nl;
          continue;
        }
        if (ch === '"') {
          stack.push({ kind: "double" });
          out += ch;
          i++;
          continue;
        }
        if (ch === "$" && input[i + 1] === "(") {
          stack.push({ kind: "subst", parenDepth: 1 });
          out += "$(";
          i += 2;
          continue;
        }
        if (top?.kind === "subst") {
          if (ch === "(") {
            top.parenDepth++;
            out += ch;
            i++;
            continue;
          }
          if (ch === ")") {
            top.parenDepth--;
            if (top.parenDepth === 0) stack.pop();
            out += ch;
            i++;
            continue;
          }
        }
        if (ch === "'") {
          const leftOk = i === 0 || /[\s;|&()=<>]/.test(input[i - 1]!);
          let cursor = i;
          let closed = false;
          while (cursor < input.length && input[cursor] === "'") {
            const close = input.indexOf("'", cursor + 1);
            if (close === -1) {
              closed = false;
              break;
            }
            closed = true;
            cursor = close + 1;
            if (cursor + 1 < input.length && input[cursor] === "\\" && input[cursor + 1] === "'") {
              cursor += 2;
              continue;
            }
            break;
          }
          if (!closed) {
            // Unterminated single quote: fail closed.
            out += input.slice(i);
            break;
          }
          const rightOk = cursor === input.length || /[\s;|&()<>]/.test(input[cursor]!);
          out += leftOk && rightOk ? "''" : input.slice(i, cursor);
          i = cursor;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    };

    const hasActiveDynamicPiAgentAccess = (text: string): boolean => {
      const active = stripStandaloneSingleQuotes(text);
      return dynamicPiAgentAccessRe.test(active) || dynamicPiAgentAccessRe.test(collapseFragments(active));
    };

    const resolveEffectiveCmd = (tokens: string[], startIdx: number): { idx: number; word: string } => {
      let i = startIdx;
      while (i < tokens.length) {
        const raw = tokens[i]!;
        const bare = basename(raw.replace(/^[()]+/, "")).toLowerCase();
        if (WRAPPER_WORDS.has(bare) || bare === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
          i++;
          while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i] !== "--") {
            const flag = tokens[i]!;
            if (!flag.includes("=") && (ENV_VALUE_OPTIONS.has(flag) || WRAPPER_VALUE_OPTIONS.has(flag))) {
              i += 2;
            } else {
              i++;
            }
          }
          if (tokens[i] === "--") i++;
          if (bare === "timeout" && i < tokens.length && /^\d/.test(tokens[i]!)) i++;
          continue;
        }
        if (bare === "uv" && tokens[i + 1] === "run") {
          i += 2;
          while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i] !== "--") {
            const flag = tokens[i]!;
            if (
              !flag.includes("=") &&
              (flag === "--with" ||
                flag === "--group" ||
                flag === "--python" ||
                flag === "-p" ||
                flag === "--directory" ||
                flag === "--project")
            ) {
              i += 2;
            } else {
              i++;
            }
          }
          if (tokens[i] === "--") i++;
          continue;
        }
        return { idx: i, word: bare };
      }
      return { idx: startIdx, word: basename(tokens[startIdx] ?? "").toLowerCase() };
    };

    const inlineRuntimeTargetsStateDb = (code: string): boolean => {
      const defrag = collapseFragments(code);
      const isWriteScript = scriptWriteRe.test(defrag) || /\bw\b|['"]w['"]|['"]w\+['"]|['"]a['"]/.test(defrag);
      const mentionsStateDbLocal =
        stateDbUncondRe.test(defrag) ||
        /\b(?:restricted_folder_approvals|tool_host_approvals)\b/i.test(defrag);
      return (
        (isWriteScript || sqliteEngineRe.test(defrag) || /\bsqlite\b/i.test(defrag)) &&
        (mentionsStateDbLocal ||
          (/\.pi\b/i.test(defrag) && /(?:state\.db|restricted_folder_approvals)/i.test(defrag)) ||
          (/join\s*\([^)]*\.pi/i.test(defrag) && /\bdata\b/i.test(defrag)))
      );
    };

    const checkProtectedSecurityStorage = (
      rawScript: string,
      parentVars: Map<string, string>,
      depth = 0,
    ): "hmac" | "settings" | "state_db" | null => {
      if (depth > 3) return null;
      const script = preprocessAnsiCQuotes(rawScript);
      const defragFull = collapseFragments(script);
      // Literal `.approval-hmac-key` stays unconditionally blocked everywhere (even in quotes/heredocs).
      if (hmacKeyRe.test(defragFull)) return "hmac";

      const { stripped: withoutQuotedHeredocs, quotedBodies: quotedHeredocBodies } =
        extractQuotedHeredocs(script);
      if (hasActiveDynamicPiAgentAccess(withoutQuotedHeredocs)) return "hmac";

      const vars = new Map(parentVars);
      let sawPiFragmentVar = false;
      let sawStateDbFragmentVar = false;

      for (const seg of unquotedSegments(withoutQuotedHeredocs)) {
        const rawTokens = tokenize(seg.text);
        if (rawTokens.length === 0) continue;

        // Track `set -- arg1 arg2 ...` positional parameters ($1, $2, $@, $*)
        if (rawTokens[0] === "set") {
          const ddIdx = rawTokens.indexOf("--");
          if (ddIdx !== -1) {
            const posArgs = rawTokens
              .slice(ddIdx + 1)
              .map((a) => collapseFragments(expandShellVars(stripOuterQuotesSimple(a), vars)));
            // Clear stale positional params before setting new ones
            for (const key of [...vars.keys()]) {
              if (/^[0-9]+$/.test(key) || key === "@" || key === "*") vars.delete(key);
            }
            posArgs.forEach((val, idx) => {
              vars.set(String(idx + 1), val);
              if (/\.pi\b|pi-config|settings\.json/i.test(val)) sawPiFragmentVar = true;
              if (/\.pi\/data|state\.db|restricted_folder_approvals|tool_host_approvals/i.test(val)) sawStateDbFragmentVar = true;
            });
            if (posArgs.length > 0) {
              vars.set("@", posArgs.join(" "));
              vars.set("*", posArgs.join(" "));
            }
            if (posArgs.some((v) => hmacKeyRe.test(v))) return "hmac";
            continue;
          }
        }

        for (const tok of rawTokens) {
          if (tok === "export" || tok === "local" || tok === "readonly" || tok === "declare" || tok === "typeset") {
            continue;
          }
          const am = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
          if (!am) break;
          const val = collapseFragments(expandShellVars(stripOuterQuotesSimple(am[2]!), vars));
          vars.set(am[1]!, val);
          if (/\.pi\b|pi-config|settings\.json/i.test(val)) sawPiFragmentVar = true;
          if (/\.pi\/data|state\.db|restricted_folder_approvals|tool_host_approvals/i.test(val)) sawStateDbFragmentVar = true;
        }

        const expandedSeg = expandShellVars(seg.text, vars);
        const defragSeg = collapseFragments(expandedSeg);
        const maskedSeg = maskQuotedRegions(defragSeg);

        if (
          hmacKeyRe.test(defragSeg) ||
          hasActiveDynamicPiAgentAccess(expandShellVars(stripStandaloneSingleQuotes(seg.text), vars))
        ) {
          return "hmac";
        }

        const expandedTokens = tokenize(expandedSeg);
        const cmdIdx = expandedTokens.length > 0 ? skipToCommandWord(expandedTokens) : 0;
        const { idx: effectiveCmdIdx, word: cmdWord } = resolveEffectiveCmd(expandedTokens, cmdIdx);
        const prefixBeforeSeg = seg.start > 0 ? withoutQuotedHeredocs.slice(0, seg.start) : "";
        const segReceivesStdin =
          prefixBeforeSeg.trimEnd().endsWith("|") ||
          /(?:^|[\s;|&()])(?:<<<?|<(?!\())/.test(maskedSeg);
        const priorSegmentWroteFile = /[>]|\b(?:tee|sponge)\b/.test(prefixBeforeSeg);

        // 1. State DB & approval tables tamper check (unconditional)
        const mentionsStateDb =
          stateDbUncondRe.test(defragSeg) ||
          /\b(?:restricted_folder_approvals|tool_host_approvals)\b/i.test(defragSeg);
        if (
          sqliteEngineRe.test(defragSeg) &&
          !isVerifiablyReadOnlySqliteSeg(expandedTokens, cmdIdx, maskedSeg) &&
          (mentionsStateDb ||
            (/\.pi\/data\b/i.test(defragSeg) && !/\b(?:pr-)?reviews\.db\b/i.test(defragSeg)) ||
            (sawStateDbFragmentVar && unresolvedVarOrPositionalRe.test(expandedSeg)))
        ) {
          return "state_db";
        }
        if (
          mentionsStateDb &&
          (bashWritesToPath(defragSeg, maskedSeg, "\\.pi/data/state\\.d(?:b(?:-wal|-shm)?|[?*[{][^\\s\"'`;|&)]*)") ||
            /(?:>>?|>\|)\s*["']?[^\s"'`;|&)]*\.pi\/data\/state\.d/i.test(maskedSeg))
        ) {
          return "state_db";
        }

        // 2. pi-config-settings write check (handles fragmented / variable-assembled paths!)
        const mentionsSettingsPath =
          settingsPathRe.test(defragSeg) || /\bpi-config-settings\b/i.test(defragSeg);
        if (
          mentionsSettingsPath &&
          (bashWritesToPath(defragSeg, maskedSeg, "pi-config-settings") ||
            /(?:>>?|>\|)\s*["']?[^\s"'`;|&)]*\.pi\/pi-config-settings/i.test(defragSeg))
        ) {
          return "settings";
        }
        // Fail closed when a shell redirect (`>` / `>>` / `tee` / `sponge`) writes into `.pi/` via
        // unresolved variables or globs after an earlier `.pi`/settings fragment assignment.
        if (
          sawPiFragmentVar &&
          /(?:>>?|>\|)\s*["']?[^\s"'`;|&)]*(?:\.pi\/|\$)|(?:^|[\s;&|(])(?:tee|sponge)(?:\s+-[A-Za-z-]+)*\s+["']?[^\s"'`;|&)]*(?:\.pi\/|\$)/i.test(
            expandedSeg,
          )
        ) {
          return "settings";
        }

        if (expandedTokens.length === 0) continue;

        // Direct file-mutating commands targeting state.db (note: settings `cp`/interpreter
        // co-occurrence is intentionally kept out of the narrow text guard per PR #950;
        // restricted_folders enforces a monotonic in-process floor against external tampering).
        if (fileMutateOps.has(cmdWord)) {
          if (mentionsStateDb || (sawStateDbFragmentVar && unresolvedVarOrPositionalRe.test(expandedSeg))) {
            return "state_db";
          }
        }

        // Inline scripts (`python3 -c`, `node -e`, etc.) constructing `.pi/agent/` or `.pi/data/state.db`
        if (inlineRuntimeOps.has(cmdWord)) {
          const checkInlineCode = (code: string): "hmac" | "state_db" | null => {
            if (dynamicPiAgentAccessRe.test(code) || inlineRuntimeDynamicPiAgentRe.test(code)) {
              enfLog.debug("inline_runtime_dynamic_pi_agent_blocked", "cmd", cmdWord);
              return "hmac";
            }
            if (inlineRuntimeTargetsStateDb(code)) return "state_db";
            return null;
          };
          const segHit = checkInlineCode(expandedSeg);
          if (segHit) return segHit;
          for (const body of quotedHeredocBodies) {
            const bodyHit = checkInlineCode(body);
            if (bodyHit) return bodyHit;
          }
          if (segReceivesStdin || priorSegmentWroteFile) {
            const rawHit = checkInlineCode(script);
            if (rawHit) return rawHit;
          }
        }

        // Recurse into nested shells (`bash -c`, `sh -c`, `eval`, `source`/`.`, `xargs <shell>`, or stdin/file-fed shells)
        const isSourceOrDot = cmdWord === "source" || cmdWord === ".";
        const isXargsExec =
          cmdWord === "xargs" &&
          expandedTokens
            .slice(effectiveCmdIdx + 1)
            .some((t) => {
              const b = basename(t).toLowerCase();
              return SHELL_WORDS.has(b) || inlineRuntimeOps.has(b);
            });
        if (cmdWord === "eval" || isSourceOrDot || isXargsExec || runsNestedShell(expandedTokens)) {
          const nested: string[] = [];
          if (cmdWord === "eval") {
            const evalArgs: string[] = [];
            for (let i = effectiveCmdIdx + 1; i < expandedTokens.length; i++) {
              const t = expandedTokens[i]!;
              if (evalArgs.length === 0 && t === "--") continue;
              evalArgs.push(stripOuterQuotesSimple(t));
            }
            if (evalArgs.length > 0) nested.push(evalArgs.join(" "));
          } else if (!isSourceOrDot && !isXargsExec) {
            for (let i = effectiveCmdIdx + 1; i < expandedTokens.length; i++) {
              const tok = expandedTokens[i]!;
              if (tok === "--") break;
              if (/^-[a-zA-Z]*c$/.test(tok) && i + 1 < expandedTokens.length) {
                const body = unwrapShellArgQuotes(expandedTokens[i + 1]!);
                if (body) nested.push(body);
                i++;
              } else {
                const attached = /^-[a-zA-Z]*c(.+)$/.exec(tok);
                if (attached) {
                  const body = unwrapShellArgQuotes(attached[1]!);
                  if (body) nested.push(body);
                }
              }
            }
          }
          for (const inner of nested) {
            const innerHit = checkProtectedSecurityStorage(inner, vars, depth + 1);
            if (innerHit) return innerHit;
          }
          if (nested.length === 0) {
            for (const body of quotedHeredocBodies) {
              const bodyHit = checkProtectedSecurityStorage(body, vars, depth + 1);
              if (bodyHit) return bodyHit;
            }
            if (
              (isSourceOrDot || isXargsExec || segReceivesStdin || priorSegmentWroteFile) &&
              (dynamicPiAgentAccessRe.test(script) ||
                (isXargsExec && inlineRuntimeDynamicPiAgentRe.test(script)))
            ) {
              enfLog.debug("indirect_shell_dynamic_pi_agent_blocked", "cmd", cmdWord);
              return "hmac";
            }
          }
        }
      }
      return null;
    };

    const storageHit = checkProtectedSecurityStorage(command, new Map());
    if (storageHit === "hmac") {
      enfLog.warn("approval_hmac_key_bash_blocked");
      return {
        action: "block",
        reason:
          "\u26d4 Access to .approval-hmac-key is blocked. Approval integrity keys are managed exclusively by the enforcement system.",
      };
    }
    if (storageHit === "settings") {
      enfLog.warn("protected_settings_bash_write_blocked");
      return {
        action: "block",
        reason:
          "\u26d4 Bash command writing pi-config-settings blocked — it carries the dangerous-command allowlist and restricted folders. Change settings via the /pi-config-settings command or your own editor.",
      };
    }
    if (storageHit === "state_db") {
      enfLog.warn("state_db_bash_tamper_blocked");
      return {
        action: "block",
        reason:
          "\u26d4 Bash command targeting enforcement state storage (.pi/data/state.db / restricted_folder_approvals) blocked. State storage is managed exclusively by the enforcement system.",
      };
    }
  }

  // Block bash WRITES targeting the settings files (issue #949 / PR #950) and
  // git identity config files (issue #995).
  const maybeSettingsWrite = cmdLower.includes("pi-config-settings");
  const maybeIdentityWrite =
    cmdLower.includes("gitconfig") ||
    cmdLower.includes("git/config") ||
    unquotedSegments(command).some((seg) => runsNestedShell(tokenize(seg.text)));
  if (maybeSettingsWrite || maybeIdentityWrite) {
    const maskedCmd = maskQuotedRegions(command);
    if (maybeSettingsWrite && bashWritesToPath(command, maskedCmd, "pi-config-settings")) {
      return {
        action: "block",
        reason:
          "\u26d4 Bash command writing pi-config-settings blocked — it carries the dangerous-command allowlist and restricted folders. Change settings via the /pi-config-settings command or your own editor.",
      };
    }
    if (maybeIdentityWrite && bashWritesToPath(command, maskedCmd, gitIdentityConfigSrc())) {
      enfLog.error("git_identity_config_write_blocked");
      return {
        action: "block",
        reason:
          "\u26d4 Bash command writing a git identity config (~/.gitconfig, ~/.config/git/config, .git/config) blocked. " +
          "The git identity belongs to the human — if it is wrong, tell the user to fix their own git config.",
      };
    }
  }

  // Strip timeout on long-running poll commands (rate limit waits can exceed 30m).
  if (/\bmyk-pi-tools\b[\s\S]*\breviews\s+poll\b/.test(command) && input.hasTimeout) {
    stripTimeout = true;
  }

  const pythonCheck = checkPythonPipBlock(command, cmdLower);
  if (pythonCheck) {
    if ("autofix" in pythonCheck) {
      cmdRef.current = pythonCheck.modifiedCommand;
      cmdRef.modified = true;
    } else {
      return { action: "block", reason: pythonCheck.reason };
    }
  }

  // Block memory writes from specialist agents — only orchestrator can write.
  if (isSubagentChild && /\bmyk-pi-tools\b.*\bmemory\s+(add|delete)\b/.test(command)) {
    return {
      action: "block",
      reason: "Memory writes are restricted to the orchestrator. Specialists can only search/list memories.",
    };
  }

  // Block direct docker/podman CLI in container — force docker-safe wrapper.
  if (input.inContainer && /(?:^|[|;&]\s*)(?:docker|podman)\s/.test(cmdLower) && !cmdLower.includes("docker-safe")) {
    return {
      action: "block",
      reason: "Direct docker/podman forbidden. Use docker-safe for read-only container inspection (ps, logs, inspect, top, stats).",
    };
  }

  // Block sleep inside loops / long sleeps — force async in the orchestrator.
  const hasLoop = /\b(while|for|until)\b/.test(command);
  const sleepMatch = command.match(/\bsleep\s+(\d+)/);
  const asyncRouteAvailable = !isSubagentChild;
  if (
    asyncRouteAvailable &&
    hasLoop &&
    sleepMatch &&
    parseInt(sleepMatch[1], 10) > getSetting(input.cwd, "enforcement_loop_sleep_threshold_s")
  ) {
    return {
      action: "block",
      reason: `⚠️ Polling loop with sleep ${sleepMatch[1]}s blocked. Use subagent with async: true for polling/monitoring tasks instead of blocking the session.`,
    };
  }

  if (
    asyncRouteAvailable &&
    !hasLoop &&
    sleepMatch &&
    parseInt(sleepMatch[1], 10) > getSetting(input.cwd, "enforcement_sleep_threshold_s")
  ) {
    enfLog.info("dangerous_gate_sleep_blocked", {
      seconds: Number(sleepMatch[1]),
      threshold: getSetting(input.cwd, "enforcement_sleep_threshold_s"),
    });
    return {
      action: "block",
      reason: `⚠️ sleep ${sleepMatch[1]}s blocked — too long. Use subagent with async: true instead of blocking the session.`,
    };
  }

  const remoteCheck = checkRemoteExecBlock(cmdLower);
  if (remoteCheck && "block" in remoteCheck) {
    return { action: "block", reason: remoteCheck.reason };
  }

  // comment_signature: inject Assisted-by footer into gh pr/issue create|comment|edit bodies.
  if (getSetting(input.cwd, "comment_signature")) {
    const modelId = resolveCommentSignatureModelId(input.ctxModelId);
    const signature = `Assisted-by: PI (${modelId})`;
    const injected = injectGhBodySignature(cmdRef.current, signature);
    if (injected !== cmdRef.current) {
      enfLog.info("comment_signature injected into gh body command", signature);
      cmdRef.current = injected;
      cmdRef.modified = true;
    }
  }

  // Git identity belongs to the human (issue #995).
  const identityOverride = gitIdentityOverride(command);
  if (identityOverride) {
    enfLog.error("git_identity_override_blocked", "source", identityOverride);
    return {
      action: "block",
      reason:
        `\u26d4 Git identity override blocked (${identityOverride}). The git identity belongs to the human: ` +
        "never set user.name/user.email, GIT_AUTHOR_*/GIT_COMMITTER_*, --author, or `git config user.*`. " +
        "If the identity is wrong, tell the user to fix their own git config.",
    };
  }

  // Enforce git commit/push only via git-expert agent.
  if (agentName !== "git-expert" && isRealGitCommitOrPush(command)) {
    return {
      action: "block",
      reason: "⛔ git commit/push blocked. Use git-expert agent for commit and push operations.",
    };
  }

  // Conflict resolution belongs to conflict-resolver (blocked for git-expert).
  if (agentName === "git-expert" && createsAndResolvesConflict(command)) {
    enfLog.error("conflict_created_and_resolved", "agent", agentName ?? "unknown");
    return {
      action: "block",
      reason:
        "\u26d4 This command starts a merge/rebase/cherry-pick and then stages a resolution of it. " +
        "The conflict does not exist yet, so it cannot be checked. Delegate to the conflict-resolver " +
        'agent (subagent(agent="conflict-resolver")), and let git-expert commit the staged result.',
    };
  }
  if (agentName === "git-expert" && isConflictResolutionCommand(command)) {
    const { all, envOverride, dynamicPath } = conflictCandidateDirs(command, input.cwd);
    if (dynamicPath) {
      return {
        action: "block",
        reason:
          `⛔ ${dynamicPath} is expanded by the shell, so the repository it selects cannot be verified. ` +
          "Do not resolve conflicts in git-expert — abort and delegate to the " +
          `conflict-resolver agent (subagent(agent="conflict-resolver")).`,
      };
    }
    if (envOverride) {
      return {
        action: "block",
        reason:
          `⛔ ${envOverride} selects the Git repository or index for this command, so the conflict state ` +
          "cannot be verified. Do not resolve conflicts in git-expert — abort and delegate to the " +
          `conflict-resolver agent (subagent(agent="conflict-resolver")).`,
      };
    }
    const conflicted: string[] = [];
    const unreadable: string[] = [];
    for (const dir of all) {
      const lookup = listUnmergedFiles(dir);
      if (!lookup.ok) {
        if (isInsideGitWorkTree(dir)) unreadable.push(dir);
        continue;
      }
      for (const file of lookup.files) conflicted.push(dir === input.cwd ? file : `${dir} → ${file}`);
    }
    if (conflicted.length === 0 && unreadable.length > 0) {
      enfLog.error("conflict_lookup_failed", unreadable.join(", "));
      return {
        action: "block",
        reason:
          `⛔ Could not read the unmerged index in ${unreadable.join(", ")}, so the conflict state is ` +
          "unknown. Refusing to run a resolution command blind: run `git status` to see where you are, " +
          `or delegate to the conflict-resolver agent (subagent(agent="conflict-resolver")).`,
      };
    }
    if (conflicted.length > 0) {
      enfLog.error("conflict_resolution_blocked", conflicted.join(", "));
      return {
        action: "block",
        reason:
          `⛔ Unresolved conflicts in ${conflicted.join(", ")}. Do not resolve them in git-expert — ` +
          `stop, report this message to the caller, and have it delegate to the conflict-resolver ` +
          `agent (subagent(agent="conflict-resolver")). To back out instead: ` +
          `git merge --abort / git rebase --abort / git cherry-pick --abort.`,
      };
    }
  }

  // Review-loop commit gate + git protection.
  const hasGitWord = /\bgit\b/.test(command);
  const isGitExpertCommit = agentName === "git-expert" && realGitSub(command, "commit");
  const gitCwd = hasGitWord || isGitExpertCommit ? resolveEffectiveCwd(command, input.cwd) : input.cwd;
  let prefetchedBranch: string | null | undefined = undefined;
  if (isGitExpertCommit && input.checkReviewLoopCommit) {
    prefetchedBranch = getCurrentBranch(gitCwd);
    const reviewGate = input.checkReviewLoopCommit(gitCwd, prefetchedBranch);
    if (reviewGate) return { action: "block", reason: reviewGate.reason };
  }

  const gitCheck = hasGitWord
    ? await checkGitProtection(command, cmdRef, input, gitCwd, prefetchedBranch)
    : undefined;
  if (gitCheck && "block" in gitCheck) {
    return { action: "block", reason: gitCheck.reason };
  }

  const tmpCheck = checkTempFileEnforcement(command, input.cwd);
  if (tmpCheck && "block" in tmpCheck) {
    return { action: "block", reason: tmpCheck.reason };
  }

  const dangerCheck = await checkDangerousCommands(command, input.cwd, sessionId, input.ui);
  if (dangerCheck && "block" in dangerCheck) {
    return { action: "block", reason: dangerCheck.reason };
  }

  return {
    action: "allow",
    ...(cmdRef.modified ? { modifiedCommand: cmdRef.current } : {}),
    ...(stripTimeout ? { stripTimeout: true } : {}),
  };
}
