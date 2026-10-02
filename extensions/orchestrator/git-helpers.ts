/**
 * Git utility functions for enforcement and status line.
 */

import { execFile, execSync } from "node:child_process";
import { resolve } from "node:path";
import { createLogger } from "../shared/logger.js";

const gitLog = createLogger("git-helpers");

export function runGit(
  args: string[],
  cwd?: string,
): { stdout: string; code: number } {
  try {
    const stdout = execSync(`git --no-optional-locks ${args.join(" ")}`, {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    });
    return { stdout: stdout.trimEnd(), code: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || "").trimEnd(), code: e.status || 1 };
  }
}

export function getCurrentBranch(cwd?: string): string | null {
  const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (r.code === 0 && r.stdout && r.stdout !== "HEAD") return r.stdout;
  const s = runGit(["symbolic-ref", "HEAD"], cwd);
  if (s.code === 0 && s.stdout.startsWith("refs/heads/"))
    return s.stdout.slice("refs/heads/".length);
  return null;
}

export function getMainBranch(cwd?: string): string | null {
  for (const b of ["main", "master"])
    if (
      runGit(["rev-parse", "--verify", "--end-of-options", b], cwd).code === 0
    )
      return b;
  return null;
}

export function isGitRepo(cwd?: string): boolean {
  return runGit(["rev-parse", "--git-dir"], cwd).code === 0;
}

export function isGithubRepo(cwd?: string): boolean {
  const r = runGit(["remote", "get-url", "origin"], cwd);
  return r.code === 0 && r.stdout.toLowerCase().includes("github.com");
}

export function isBranchMerged(branch: string, main: string, cwd?: string): boolean {
  const u = runGit(["rev-list", "--count", `${main}..${branch}`], cwd);
  if (u.code !== 0) return false;
  const n = parseInt(u.stdout, 10);
  if (isNaN(n) || n === 0) return false;
  return runGit(["merge-base", "--is-ancestor", branch, main], cwd).code === 0;
}

export function isBranchAhead(cwd?: string): boolean {
  if (
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)
      .code !== 0
  )
    return true;
  const s = runGit(["status", "--short", "--branch"], cwd);
  return s.code === 0 && s.stdout.includes("ahead");
}

export function getPrMergeStatus(
  branch: string,
  cwd?: string,
): { merged: boolean | null; info: string | null } {
  if (!isGithubRepo(cwd)) return { merged: false, info: null };
  try {
    const out = execSync(
      `gh pr list --head "${branch}" --state merged --json number --limit 1`,
      {
        cwd,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const data = JSON.parse(out);
    if (Array.isArray(data) && data.length > 0)
      return { merged: true, info: String(data[0].number || "") };
    return { merged: false, info: null };
  } catch {
    return { merged: null, info: "Could not check PR status" };
  }
}

export type OpenPr = { number: number; url: string };

const OPEN_PR_TTL_MS = 30_000;
const OPEN_PR_CACHE_MAX = 50;
const SAFE_PR_URL = /^https:\/\/[^\x00-\x1f]+$/;

type OpenPrCacheEntry = { at: number; pr: OpenPr | null };
const openPrCache = new Map<string, OpenPrCacheEntry>();
const openPrInFlight = new Map<string, Promise<OpenPr | null>>();
/** Keys with an active scheduleOpenPrStatusRefresh .then subscription. */
const openPrSchedulePending = new Set<string>();

type GhPrViewRunner = (cwd?: string) => Promise<string>;

const defaultGhPrView: GhPrViewRunner = (cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "number,url,state"],
      { cwd, timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });

let ghPrViewRunner: GhPrViewRunner = defaultGhPrView;

/** Override `gh pr view` runner (tests). Pass null to restore default. */
export function setGhPrViewRunner(runner: GhPrViewRunner | null): void {
  ghPrViewRunner = runner ?? defaultGhPrView;
}

/** Parse `gh pr view --json number,url,state` output (OPEN only). */
export function parseOpenPrJson(out: string): OpenPr | null {
  try {
    const data = JSON.parse(out);
    if (
      data &&
      Number.isInteger(data.number) &&
      data.number > 0 &&
      typeof data.url === "string" &&
      SAFE_PR_URL.test(data.url) &&
      data.state === "OPEN"
    ) {
      return { number: data.number, url: data.url };
    }
  } catch {
    // invalid JSON
  }
  return null;
}

/** Clear open-PR cache and in-flight lookups (tests). */
export function clearOpenPrCache(): void {
  openPrCache.clear();
  openPrInFlight.clear();
  openPrSchedulePending.clear();
}

/** Seed cache entry (tests) — use past `at` to exercise TTL / SWR. */
export function seedOpenPrCacheForTests(
  cwd: string,
  branch: string,
  entry: { at: number; pr: OpenPr | null },
): void {
  openPrCache.set(openPrCacheKey(cwd, branch), entry);
}

/** Evict oldest keys when over max size (LRU via touch-on-hit). */
function enforceOpenPrCacheMax(): void {
  while (openPrCache.size > OPEN_PR_CACHE_MAX) {
    const oldest = openPrCache.keys().next().value;
    if (oldest === undefined) break;
    openPrCache.delete(oldest);
  }
}

function openPrCacheKey(cwd: string | undefined, branch: string): string {
  return `${cwd || process.cwd()}:${branch}`;
}

function touchOpenPrCache(key: string, entry: OpenPrCacheEntry): void {
  openPrCache.delete(key);
  openPrCache.set(key, entry);
  enforceOpenPrCacheMax();
}

/**
 * Cached open PR only — never calls `gh`.
 * Returns stale entries past TTL (stale-while-revalidate); kick
 * {@link refreshOpenPr} to refresh asynchronously.
 * Pass `assumeGithub: true` when the caller already verified the remote.
 */
export function getOpenPr(
  cwd?: string,
  branch?: string | null,
  opts?: { assumeGithub?: boolean },
): OpenPr | null {
  const b = branch ?? getCurrentBranch(cwd);
  if (!b) return null;
  if (!opts?.assumeGithub && !isGithubRepo(cwd)) return null;

  const key = openPrCacheKey(cwd, b);
  const cached = openPrCache.get(key);
  if (!cached) return null;
  // Touch for LRU even on stale hits so hot keys survive eviction.
  touchOpenPrCache(key, cached);
  return cached.pr;
}

/**
 * Async `gh pr view` for the current (or given) branch.
 * Coalesces in-flight lookups per cwd+branch; caches result for 30s.
 * Status-line callers must use {@link getOpenPr} synchronously and only
 * await this to refresh — never block the update path on `gh`.
 * Pass `assumeGithub: true` when the caller already verified the remote.
 */
export function refreshOpenPr(
  cwd?: string,
  branch?: string | null,
  opts?: { assumeGithub?: boolean },
): Promise<OpenPr | null> {
  const b = branch ?? getCurrentBranch(cwd);
  if (!b) return Promise.resolve(null);
  if (!opts?.assumeGithub && !isGithubRepo(cwd)) return Promise.resolve(null);

  const now = Date.now();
  const key = openPrCacheKey(cwd, b);
  const cached = openPrCache.get(key);
  if (cached && now - cached.at < OPEN_PR_TTL_MS) {
    touchOpenPrCache(key, cached);
    return Promise.resolve(cached.pr);
  }

  const inflight = openPrInFlight.get(key);
  if (inflight) return inflight;

  const pending = (async (): Promise<OpenPr | null> => {
    let pr: OpenPr | null = null;
    try {
      const out = await ghPrViewRunner(cwd);
      pr = parseOpenPrJson(out.trim());
    } catch {
      pr = null;
    }
    touchOpenPrCache(key, { at: Date.now(), pr });
    return pr;
  })().finally(() => {
    openPrInFlight.delete(key);
  });

  openPrInFlight.set(key, pending);
  return pending;
}

/** True when an async open-PR refresh still matches the active cwd/branch. */
export function shouldApplyOpenPrRefresh(
  lastCtx: { cwd?: string } | null,
  lastBranch: string | null,
  refreshKey: string,
): boolean {
  if (!lastCtx || lastBranch == null) return false;
  return `${lastCtx.cwd || ""}:${lastBranch}` === refreshKey;
}

export type OpenPrRefreshDecision = "skip" | "rerender";

/** Decide whether a finished refresh should re-run the status-line update. */
export function decideOpenPrRefreshRerender(args: {
  lastCtx: { cwd?: string } | null;
  lastBranch: string | null;
  refreshKey: string;
  shownKey: string;
  fresh: OpenPr | null;
}): OpenPrRefreshDecision {
  if (
    !shouldApplyOpenPrRefresh(args.lastCtx, args.lastBranch, args.refreshKey)
  ) {
    return "skip";
  }
  const freshKey = args.fresh
    ? `${args.fresh.number}\0${args.fresh.url}`
    : "";
  if (freshKey === args.shownKey) return "skip";
  return "rerender";
}

/**
 * Status-line open-PR refresh callback wiring (no TUI deps).
 * Schedules refreshOpenPr and optionally re-renders when the result applies.
 */
export function scheduleOpenPrStatusRefresh(opts: {
  cwd?: string;
  branch: string;
  shownPr: OpenPr | null;
  getState: () => {
    lastCtx: { cwd?: string } | null;
    lastBranch: string | null;
  };
  onRerender: (ctx: { cwd?: string }) => void;
  assumeGithub?: boolean;
  refresh?: typeof refreshOpenPr;
}): void {
  const refreshKey = `${opts.cwd || ""}:${opts.branch}`;
  // One .then per in-flight key — refreshOpenPr coalesces Promises but
  // repeated schedule calls would otherwise all fire onRerender.
  if (openPrSchedulePending.has(refreshKey)) return;
  openPrSchedulePending.add(refreshKey);

  const shownKey = opts.shownPr
    ? `${opts.shownPr.number}\0${opts.shownPr.url}`
    : "";
  const refresh = opts.refresh ?? refreshOpenPr;
  try {
    void refresh(opts.cwd, opts.branch, {
      assumeGithub: opts.assumeGithub,
    })
      .then((fresh) => {
        const { lastCtx, lastBranch } = opts.getState();
        if (
          decideOpenPrRefreshRerender({
            lastCtx,
            lastBranch,
            refreshKey,
            shownKey,
            fresh,
          }) !== "rerender"
        ) {
          return;
        }
        if (!lastCtx) return;
        try {
          opts.onRerender(lastCtx);
        } catch (e: any) {
          console.debug(
            "[status-line] open-PR refresh update failed:",
            e?.message || e,
          );
        }
      })
      .finally(() => {
        openPrSchedulePending.delete(refreshKey);
      })
      .catch((e: any) => {
        console.debug(
          "[status-line] open-PR refresh failed:",
          refreshKey,
          e?.message || e,
        );
      });
  } catch {
    openPrSchedulePending.delete(refreshKey);
  }
}

// Cache protected branches per repo (fetched once per session)
const protectedBranchesCache = new Map<string, Set<string>>();

export function getProtectedBranches(cwd?: string): Set<string> {
  const repoKey = cwd || process.cwd();
  if (protectedBranchesCache.has(repoKey)) return protectedBranchesCache.get(repoKey)!;

  const fallback = new Set(["main", "master"]);

  if (!isGithubRepo(cwd)) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  // Get owner/repo from remote URL
  const remote = runGit(["remote", "get-url", "origin"], cwd);
  if (remote.code !== 0) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  const match = remote.stdout.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }

  const repo = match[1];
  try {
    const out = execSync(
      `gh api repos/${repo}/branches --paginate --jq '.[] | select(.protected==true) | .name'`,
      { cwd, timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branches = new Set(
      out.split("\n").map((b) => b.trim()).filter(Boolean),
    );
    // Always include main/master as fallback
    branches.add("main");
    branches.add("master");
    protectedBranchesCache.set(repoKey, branches);
    return branches;
  } catch {
    protectedBranchesCache.set(repoKey, fallback);
    return fallback;
  }
}

export function hasGitSub(command: string, sub: string): boolean {
  return new RegExp(
    `\\bgit\\b(?:\\s+(?:-[a-zA-Z]\\s+\\S+|-\\S+))*\\s+${sub}\\b`,
  ).test(command);
}

/**
 * Split a shell segment into words, honouring quotes and backslash escapes, so
 * `conflicted\ repo` is one word and `-c core.editor="vim -f"` is one option.
 */
export function tokenize(text: string): string[] {
  gitLog.debug("tokenize", "chars", text.length);
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

/** Closing paren of a `$(`, ignoring parens inside quotes. */
function matchingParen(cmd: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let skippedQuoted = 0;
  for (let i = open; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; skippedQuoted++; }
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      gitLog.debug("matching_paren", "at", i, "skipped_quoted", skippedQuoted);
      return i;
    }
  }
  gitLog.debug("matching_paren_unterminated", "open", open, "skipped_quoted", skippedQuoted);
  return cmd.length;
}

/** Index of the closing quote, skipping over $( ) and backtick regions. */
function closingQuote(cmd: string, open: number, quote: string): number {
  for (let i = open + 1; i < cmd.length; i++) {
    if (cmd[i] === "\\") { i++; continue; }
    if (cmd[i] === "$" && cmd[i + 1] === "(") { i = matchingParen(cmd, i + 1); continue; }
    if (cmd[i] === "`") { const end = cmd.indexOf("`", i + 1); i = end === -1 ? cmd.length : end; continue; }
    if (cmd[i] === quote) {
      gitLog.debug("closing_quote", "quote", quote, "at", i);
      return i;
    }
  }
  gitLog.debug("closing_quote_unterminated", "quote", quote, "open", open);
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
  gitLog.debug("script_argument", "command", command, "option", sawCommandOption);
  return sawCommandOption;
}

/** Does `line` terminate the heredoc? Ordinary delimiters match exactly; `<<-` allows leading tabs. */
function isHeredocTerminator(line: string, delim: string, stripTabs: boolean): boolean {
  const escaped = delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = stripTabs ? new RegExp(`^\\t*${escaped}$`) : new RegExp(`^${escaped}$`);
  const isTerminator = re.test(line);
  gitLog.debug("heredoc_terminator", "delim", delim, "strip_tabs", stripTabs, "matched", isTerminator);
  return isTerminator;
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
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|)'\n]+))/.exec(cmd.slice(i));
      if (m) {
        pendingHeredocs.push({
          delim: m[2] ?? m[3] ?? m[4],
          expand: !m[2] && !m[3],
          stripTabs: m[1] === "-",
        });
        heredocs++;
        i += m[0].length - 1;
        continue;
      }
    }

    // Heredoc bodies start after this line. One cursor walks past each body and
    // its terminator, so a second heredoc on the same line resumes in the right
    // place instead of inside the first body.
    if (ch === "\n" && pendingHeredocs.length > 0) {
      let cursor = i + 1;
      for (const h of pendingHeredocs) {
        const bodyLines: string[] = [];
        let closed = false;
        // Consume the whole body — every line until the terminator — so the
        // outer scan cannot resume inside body text.
        while (cursor <= cmd.length) {
          let lineEnd = cmd.indexOf("\n", cursor);
          const atEnd = lineEnd === -1;
          if (atEnd) lineEnd = cmd.length;
          const line = cmd.slice(cursor, lineEnd);
          if (isHeredocTerminator(line, h.delim, h.stripTabs)) {
            cursor = Math.min(lineEnd + 1, cmd.length);
            closed = true;
            break;
          }
          bodyLines.push(line);
          cursor = atEnd ? cmd.length : lineEnd + 1;
          if (atEnd) break;
        }
        if (h.expand && keepSubstitutions) add(` ${executableText(bodyLines.join("\n"), depth + 1, "body")} `);
        if (!closed) break;
      }
      pendingHeredocs.length = 0;
      // A newline, so whatever follows the terminator starts its own command.
      add("\n");
      i = cursor - 1;
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
  gitLog.debug("shell_scan", "depth", depth, "mode", mode, "heredocs", heredocs, "substitutions", substitutions, "continuations", continuations, "comments", comments, "here_strings", hereStrings);
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
const WRAPPER_VALUE_OPTIONS = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role",
  "-t", "--type", "-U", "--other-user", "-C", "--chdir", "--preserve-env",
]);

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
  gitLog.debug("segment_runs_git", "verdict", verdict);
  return verdict;
}

function classifySegment(segment: string): boolean {
  const words = tokenize(segment.trim());
  let k = 0;
  while (k < words.length) {
    // `function NAME { ... }` puts the name between the keyword and the body.
    if (words[k] === "function") { k += 2; continue; }
    if (SEGMENT_SKIP.has(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { k += 1; continue; }
    break;
  }
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
    let k = 0;
    while (k < words.length) {
      // `function NAME { ... }` puts the name between the keyword and the body.
      if (words[k] === "function") { k += 2; continue; }
      if (SEGMENT_SKIP.has(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { k += 1; continue; }
      break;
    }
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
  gitLog.debug("executed_git_commands", "count", kept.length);
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
  let k = 0;
  while (k < words.length) {
    if (words[k] === "function") { k += 2; continue; }
    if (SEGMENT_SKIP.has(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { k += 1; continue; }
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
function gitScopeValues(words: string[], gitAt = 0): string[] {
  const values: string[] = [];
  // Two regions contribute: the wrapper's own options before git — `sudo -C a
  // git` changes directory through sudo and git inherits it — and git's own
  // global options after it. Both are applied in order, so the scope is the
  // directory these commands really reach.
  // In the wrapper region a plain word is the wrapper itself and is stepped
  // over; in git's own region the first plain word is the subcommand and ends it.
  const read = (from: number, to: number, skipPlainWords: boolean) => {
    for (let i = from; i < to; i++) {
      const tok = words[i];
      if (!tok.startsWith("-") || tok === "-") {
        if (skipPlainWords) continue;
        break;
      }
      if (tok === "-C") { if (words[i + 1]) values.push(words[i + 1]); i++; continue; }
      if (tok.startsWith("-C") && tok.length > 2) { values.push(tok.slice(2)); continue; }
      if (tok.includes("=")) continue;
      if (GLOBAL_LONG_VALUE_OPTIONS.has(tok) && words[i + 1]) i++;
    }
  };
  read(0, gitAt, true);
  read(gitAt + 1, words.length, false);
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
      gitLog.debug("conflict_created_and_resolved", "scope", scope || "cwd", "subcommand", sub);
      return true;
    }
  }
  gitLog.debug("conflict_created_and_resolved", "started", started.size, "resolved", false);
  return false;
}

export function isConflictResolutionCommand(command: string): boolean {
  const scanned = executableText(command);
  // Nesting deeper than the scan depth means the scanner stopped early. Treat
  // that as a resolution command rather than as proof there is none — checked on
  // the scan itself, before filtering, or the marker would be filtered away.
  if (scanned.includes(UNSCANNED)) {
    gitLog.warn("conflict_command_unscanned", "depth_limit", 6);
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
      gitLog.warn("conflict_command_dynamic_subcommand", "matches", true);
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
  gitLog.debug("conflict_command_classified", "matches", matches);
  return matches;
}

/**
 * Files with an unmerged index entry (merge/rebase/cherry-pick in progress).
 *
 * `ok` distinguishes "the index is clean" from "git would not answer". Callers
 * enforcing a block must fail closed on `ok: false` — treating an unreadable
 * index as an empty one turns a broken check into a silent pass.
 */
/**
 * Is this directory inside a git work tree at all? Distinguishes "no repository
 * yet" — `git init && git add -A`, a fresh clone — from "a repository whose
 * index cannot be read", which is the case worth failing closed on.
 */
export function isInsideGitWorkTree(cwd?: string): boolean {
  const r = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  gitLog.debug("inside_work_tree", "code", r.code);
  return r.code === 0 && r.stdout.trim() === "true";
}

export function listUnmergedFiles(cwd?: string): { ok: boolean; files: string[] } {
  // `-- :/` is the whole repository, and `--full-name` makes the paths
  // repo-relative. Without them git lists only what is under the current
  // directory, so `git add ../a.txt` from a subdirectory would read as clean
  // while staging a conflict higher up.
  const r = runGit(["ls-files", "--unmerged", "--full-name", "--", ":/"], cwd);
  if (r.code !== 0) {
    // warn, not debug: this is the check failing, and it gates a block.
    gitLog.warn("unmerged_lookup_failed", "code", r.code, "repo", Boolean(cwd));
    return { ok: false, files: [] };
  }
  const files = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    // <mode> <sha> <stage>\t<path>
    const path = line.slice(line.indexOf("\t") + 1).trim();
    if (path) files.add(path);
  }
  gitLog.debug("unmerged_lookup", "count", files.size);
  return { ok: true, files: [...files] };
}

export const DANGEROUS = [
  /\brm\s+(?:-[a-zA-Z]+\s+)*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  /\bmkfs\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i,
  /\bgit\b[\s\S]*\bclean\b[\s\S]*(?:--force|-\S*f)/i,
  /\bfind\b[\s\S]*\s-delete\b/i,
  /\bfind\b[\s\S]*-exec(?:dir)?\s+(?:\/\S+\/)?rm\b/i,
  /\bxargs\s+(?:-\S+\s+)*(?:\/\S+\/)?rm\b/i,
  /(?:^|[\s|])(ba|da|z|k|c|tc|fi)?sh\s*$/i,
];
