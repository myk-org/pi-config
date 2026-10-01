/**
 * Git utility functions for enforcement and status line.
 */

import { execFile, execSync } from "node:child_process";
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
const UNSCANNED = " unscanned-nesting ";

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
  gitLog.debug("matching_paren_unterminated", "skipped_quoted", skippedQuoted);
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
  gitLog.debug("closing_quote_unterminated", "quote", quote);
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

function executableText(cmd: string, depth = 0, mode: ScanMode = "full"): string {
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

    // A backslash-newline is a line continuation: the shell removes both, so
    // "git \\<newline>add x" is "git add x". Emitting the pair would hide the
    // subcommand from the matcher, which requires whitespace between them.
    if (ch === "\\" && cmd[i + 1] === "\n") {
      continuations++;
      i++;
      continue;
    }

    // A `#` at the start of a word begins a comment: nothing after it runs, so a
    // heredoc-looking token inside one must not swallow the lines below.
    if (ch === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      let end = cmd.indexOf("\n", i);
      if (end === -1) end = cmd.length;
      comments++;
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
      add(" ");
      i = cursor - 1;
      continue;
    }

    // Command substitution — always executes.
    if (ch === "$" && cmd[i + 1] === "(" && keepSubstitutions) {
      const end = matchingParen(cmd, i + 1);
      substitutions++;
      add(` ${executableText(cmd.slice(i + 2, end), depth + 1)} `);
      i = end;
      continue;
    }
    if (ch === "`" && keepSubstitutions) {
      const end = cmd.indexOf("`", i + 1);
      substitutions++;
      add(` ${executableText(cmd.slice(i + 1, end === -1 ? cmd.length : end), depth + 1)} `);
      i = end === -1 ? cmd.length : end;
      continue;
    }

    // ANSI-C quoting: $'…' — literal, but still a script argument to `sh -c`.
    const ansi = ch === "$" && cmd[i + 1] === "'";
    if (ansi || ch === "'") {
      const start = ansi ? i + 1 : i;
      const end = cmd.indexOf("'", start + 1);
      const content = cmd.slice(start + 1, end === -1 ? cmd.length : end);
      // A quoted part glued to adjacent text is part of the same shell word
      // (`g'add'` is `gadd`, `git''` is `git`), so it must be concatenated. Only
      // a standalone quoted argument collapses to a placeholder.
      // `$'…'` is its own word — the `$` is a token, not glued text.
      const glued = !ansi && start > 0 && !/[\s;&|(]/.test(cmd[start - 1]);
      if (isScriptArgument(cmd, start)) {
        if (keepSubstitutions) add(` ${executableText(content, depth + 1)} `);
        else add(" _ ");
      } else if (glued || /\bgit$/.test(out.trimEnd())) {
        // `git 'add' x` — the subcommand itself, quoted.
        add(content);
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
        if (keepSubstitutions) add(` ${executableText(content, depth + 1)} `);
      } else if (glued || /\bgit$/.test(out.trimEnd())) {
        // Part of a shell word, or the subcommand itself: keep the text so the
        // word survives concatenation.
        add(executableText(content, depth + 1, "full"));
      } else if (keepSubstitutions) {
        // Only the substitutions inside a double-quoted span execute.
        substitutions++;
        add(` ${executableText(content, depth + 1, "body")} `);
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
export function isConflictResolutionCommand(command: string): boolean {
  const cmd = executableText(command);
  // Nesting deeper than the scan depth means the scanner stopped early. Treat
  // that as a resolution command rather than as proof there is none.
  if (cmd.includes(UNSCANNED)) {
    gitLog.warn("conflict_command_unscanned", "depth_limit", 6);
    return true;
  }
  // git rm drops a conflicted deletion's unmerged entry, which is a resolution.
  const matches =
    hasGitSub(cmd, "add") ||
    hasGitSub(cmd, "restore") ||
    hasGitSub(cmd, "rm") ||
    /\bgit\b[\s\S]*\bcheckout\b[\s\S]*(?:--(?:ours|theirs|mine)|-m)\b/.test(cmd) ||
    /\bgit\b[\s\S]*\b(merge|rebase|cherry-pick)\b[\s\S]*--continue\b/.test(cmd);
  // Subcommand names only — never the command text, which can carry secrets.
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
export function listUnmergedFiles(cwd?: string): { ok: boolean; files: string[] } {
  const r = runGit(["ls-files", "--unmerged"], cwd);
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
