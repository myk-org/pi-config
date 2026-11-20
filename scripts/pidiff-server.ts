#!/usr/bin/env node
/**
 * pidiff-server — multi-session diff viewer hub.
 *
 * Single server on a fixed port (like pidash-server).
 * Pi sessions connect via /ws/pi and register their cwd.
 * Browsers connect via /ws/browser, pick a session, and get diffs.
 *
 * The server runs git commands for the selected session's cwd.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { createDaemonServer, resolveUiDir } from "./daemon-shared.ts";
import {
  batchReadGitObjects,
  parseDiffEntries,
  parseWorktreeList,
  type FileContentsData,
  type WorktreeInfo,
} from "./pidiff-git-diff.ts";
import { isGitIgnoredRelPath, parseGitIgnoredWatchFilter, type GitIgnoredWatchFilter } from "./pidiff-git-ignore.ts";
import { createLogger } from "../extensions/shared/logger.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 19290;
const port = parseInt(process.env.PI_PIDIFF_PORT || "", 10) || DEFAULT_PORT;

const PROJECT_CWD = process.env.PI_PIDIFF_CWD || "";
if (!PROJECT_CWD) {
  console.log(`${new Date().toISOString()} [pidiff] WARNING: PI_PIDIFF_CWD not set — server will only work when sessions register`);
}

function log(msg: string) {
  console.log(`${new Date().toISOString()} [pidiff] ${msg}`);
}

const slog = createLogger("pidiff");

// ── Git helpers ─────────────────────────────────────────────────────

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] as const, maxBuffer: 10 * 1024 * 1024 };

// Resolve git binary — search common paths, no PI_GIT_BIN dependency
let GIT_BIN = "git";
let gitBinResolved = false;

const GIT_SEARCH_PATHS = [
  "git",                                    // PATH lookup
  "/usr/bin/git",                            // standard Linux/container
  "/usr/local/bin/git",                      // macOS / manual install
  "/home/linuxbrew/.linuxbrew/bin/git",      // Homebrew on Linux
  "/opt/homebrew/bin/git",                   // Homebrew on macOS ARM
];

function resolveGitBin(): string {
  for (const candidate of GIT_SEARCH_PATHS) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      GIT_BIN = candidate;
      gitBinResolved = true;
      if (candidate !== "git") log(`resolved git binary: ${candidate}`);
      return GIT_BIN;
    } catch {}
  }
  log("WARNING: git binary not found in any known location");
  gitBinResolved = false;
  return GIT_BIN;
}

// Initial resolution
resolveGitBin();

function gitExec(args: string[], cwd: string): string {
  try {
    return execFileSync(GIT_BIN, args, { ...GIT_OPTS, cwd }).trim();
  } catch (e: any) {
    if (e.code === "ENOENT") {
      log(`gitExec ENOENT: binary=${GIT_BIN} args=${args.join(" ")} cwd=${cwd} — re-resolving git binary`);
      resolveGitBin();
      if (gitBinResolved) {
        return execFileSync(GIT_BIN, args, { ...GIT_OPTS, cwd }).trim();
      }
    }
    throw e;
  }
}

function getDefaultRemoteBranch(cwd: string): string {
  try {
    const ref = gitExec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    const branch = ref.replace("refs/remotes/", "");
    log(`getDefaultRemoteBranch(${cwd}): ${branch}`);
    return branch;
  } catch {
    for (const name of ["origin/main", "origin/master", "origin/develop"]) {
      try { gitExec(["rev-parse", "--verify", name], cwd); log(`getDefaultRemoteBranch(${cwd}): ${name} (fallback)`); return name; } catch {}
    }
    log(`getDefaultRemoteBranch(${cwd}): (none found)`);
    return "";
  }
}

function getBranch(cwd: string): string {
  try { return gitExec(["branch", "--show-current"], cwd); } catch { return ""; }
}

function getWorktrees(cwd: string): WorktreeInfo[] {
  try {
    const raw = execFileSync(GIT_BIN, ["worktree", "list", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024,
    });
    return parseWorktreeList(raw);
  } catch (e: any) { log(`getWorktrees error: ${e.message}`); return []; }
}

async function getWorktreesAsync(cwd: string): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(GIT_BIN, ["worktree", "list", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024,
    });
    return parseWorktreeList(stdout);
  } catch (e: any) {
    slog.warn("getWorktreesAsync error", { cwd, err: e?.message });
    return [];
  }
}

function getStatus(cwd: string): { dirty: boolean; changes: number } {
  try {
    const s = gitExec(["status", "--porcelain"], cwd);
    const changes = s ? s.split("\n").length : 0;
    return { dirty: changes > 0, changes };
  } catch { return { dirty: false, changes: 0 }; }
}



function getLog(
  cwd: string,
  count: number = 30,
  resolvedDefaultBranch?: string,
): Array<{ hash: string; short: string; subject: string; date: string }> {
  count = Math.min(count, 100); // Clamp to prevent DoS
  try {
    const defaultBranch = resolvedDefaultBranch !== undefined ? resolvedDefaultBranch : getDefaultRemoteBranch(cwd);
    // Use %x00 (NUL) as record separator and %x01 as field separator to handle newlines in subjects
    const fmt = "%H%x01%h%x01%s%x01%ai%x00";
    let args = ["log", `--format=${fmt}`, `-${count}`];
    if (defaultBranch) {
      args = ["log", `--format=${fmt}`, `-${count}`, `${defaultBranch}..HEAD`];
    }
    const raw = gitExec(args, cwd);
    if (!raw) return [];
    const commits: Array<{ hash: string; short: string; subject: string; date: string }> = [];
    for (const record of raw.split("\0").filter(Boolean)) {
      const fields = record.split("\x01");
      if (fields.length >= 4) {
        commits.push({ hash: fields[0], short: fields[1], subject: fields[2], date: fields[3] });
      }
    }
    return commits;
  } catch (e: any) { log(`getLog error: ${e.message}`); return []; }
}

// ── File-contents diff helpers ───────────────────────────────────────

function readGitObjects(cwd: string, specs: string[]): Map<string, string> {
  return batchReadGitObjects(GIT_BIN, cwd, specs, () => resolveGitBin());
}

function getChangedFiles(cwd: string, baseRef: string, headRef: string = "HEAD"): FileContentsData[] {
  try {
    const raw = gitExec(["diff", "--name-status", baseRef, headRef], cwd);
    if (!raw) return [];
    const entries = parseDiffEntries(raw);
    const specs: string[] = [];
    for (const entry of entries) {
      if (entry.status !== "added") specs.push(`${baseRef}:${entry.oldName}`);
      if (entry.status !== "deleted") specs.push(`${headRef}:${entry.name}`);
    }
    const blobs = readGitObjects(cwd, specs);
    return entries.map((entry) => ({
      name: entry.name,
      oldContents: entry.status !== "added" ? (blobs.get(`${baseRef}:${entry.oldName}`) ?? "") : "",
      newContents: entry.status !== "deleted" ? (blobs.get(`${headRef}:${entry.name}`) ?? "") : "",
      status: entry.status,
    }));
  } catch (e: any) { log(`getChangedFiles error (base=${baseRef} head=${headRef}): ${e.message}`); return []; }
}

function getStagedFiles(cwd: string): FileContentsData[] {
  try {
    const stagedRaw = gitExec(["diff", "--name-status", "--staged"], cwd);
    if (!stagedRaw) return [];
    const entries = parseDiffEntries(stagedRaw);
    const specs: string[] = [];
    for (const entry of entries) {
      if (entry.status !== "added") specs.push(`HEAD:${entry.oldName}`);
      if (entry.status !== "deleted") specs.push(`:${entry.name}`);
    }
    const blobs = readGitObjects(cwd, specs);
    return entries.map((entry) => ({
      name: entry.name,
      oldContents: entry.status !== "added" ? (blobs.get(`HEAD:${entry.oldName}`) ?? "") : "",
      newContents: entry.status !== "deleted" ? (blobs.get(`:${entry.name}`) ?? "") : "",
      status: entry.status,
    }));
  } catch (e: any) { log(`getWorkingTreeFiles staged error: ${e.message}`); return []; }
}

function getUnstagedFiles(cwd: string): FileContentsData[] {
  const unstaged: FileContentsData[] = [];
  try {
    const unstagedRaw = gitExec(["diff", "--name-status"], cwd);
    if (unstagedRaw) {
      const entries = parseDiffEntries(unstagedRaw);
      const specs: string[] = [];
      for (const entry of entries) {
        if (entry.status !== "added") specs.push(`:${entry.oldName}`);
      }
      const blobs = readGitObjects(cwd, specs);
      for (const entry of entries) {
        let newContents = "";
        if (entry.status !== "deleted") {
          try { newContents = fs.readFileSync(path.join(cwd, entry.name), "utf-8"); } catch {}
        }
        unstaged.push({
          name: entry.name,
          oldContents: entry.status !== "added" ? (blobs.get(`:${entry.oldName}`) ?? "") : "",
          newContents,
          status: entry.status,
        });
      }
    }
    const untrackedRaw = gitExec(["ls-files", "--others", "--exclude-standard"], cwd);
    if (untrackedRaw) {
      for (const file of untrackedRaw.split("\n").filter(Boolean)) {
        try {
          const newContents = fs.readFileSync(path.join(cwd, file), "utf-8");
          unstaged.push({ name: file, oldContents: "", newContents, status: "added" });
        } catch {}
      }
    }
  } catch (e: any) { log(`getWorkingTreeFiles unstaged error: ${e.message}`); }
  return unstaged;
}

function getWorkingTreeFiles(cwd: string): { staged: FileContentsData[]; unstaged: FileContentsData[] } {
  return { staged: getStagedFiles(cwd), unstaged: getUnstagedFiles(cwd) };
}

// ── Diff modes ──────────────────────────────────────────────────────

type DiffMode = "branch" | "commits";

function buildDiffPayloadWithBranch(
  cwd: string,
  mode: DiffMode,
  refs?: { from: string; to: string },
): { payload: object; defaultBranch?: string } {
  const branch = getBranch(cwd);
  const status = getStatus(cwd);

  if (mode === "branch") {
    const defaultBranch = getDefaultRemoteBranch(cwd);
    let base = "";
    try {
      base = defaultBranch ? gitExec(["merge-base", defaultBranch, "HEAD"], cwd) : "";
    } catch (e: any) {
      log(`buildDiffPayload: merge-base failed (defaultBranch=${defaultBranch}): ${e.message}`);
    }
    const committed = base ? getChangedFiles(cwd, base, "HEAD") : [];
    const working = status.dirty ? getWorkingTreeFiles(cwd) : { staged: [], unstaged: [] };
    log(`buildDiffPayload: branch mode, cwd=${cwd} defaultBranch=${defaultBranch} base=${base.slice(0, 8) || "(empty)"} branch=${branch} committed=${committed.length} staged=${working.staged.length} unstaged=${working.unstaged.length}`);
    return {
      payload: { type: "diff_update", mode: "branch", committed, staged: working.staged, unstaged: working.unstaged, branch },
      defaultBranch,
    };
  }

  if (mode === "commits" && refs) {
    const committed = getChangedFiles(cwd, refs.from, refs.to);
    return { payload: { type: "diff_update", mode: "commits", committed, staged: [], unstaged: [], branch, fromRef: refs.from, toRef: refs.to } };
  }

  return { payload: { type: "diff_update", mode, committed: [], staged: [], unstaged: [], branch } };
}

function buildDiffPayload(cwd: string, mode: DiffMode, refs?: { from: string; to: string }): object {
  return buildDiffPayloadWithBranch(cwd, mode, refs).payload;
}

function sendBranchDiffAndCommits(ws: any, cwd: string): void {
  const { payload, defaultBranch } = buildDiffPayloadWithBranch(cwd, "branch");
  try { ws.send(JSON.stringify(payload)); } catch {}
  const commits = getLog(cwd, 30, defaultBranch);
  try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
}

// ── Session state ───────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  cwd: string;
  branch: string;
  repo: string; // basename of cwd
  worktrees: WorktreeInfo[];
}

interface PiClient {
  ws: any;
  session: SessionInfo;
}

const { piClients, browserClients, browserWatchMap, broadcastToBrowsers, sendToMatchingBrowsers, start } = createDaemonServer({
  port,
  uiDir: resolveUiDir(process.argv[1], import.meta.url, "..", "extensions", "pidiff", "pidiff-ui", "dist"),
  uiName: "pidiff-ui",
  log,
  listenAddress: "127.0.0.1",

  onPiMessage: (ws, parsed, getPiClient, setPiClient) => {
    if (parsed.type === "register") {
      const sessionId = parsed.sessionId || `${parsed.pid}:${parsed.cwd}`;
      const cwd = parsed.cwd || "";
      if (!cwd) { log(`register rejected: empty cwd from ${sessionId}`); return; }
      // In per-project mode, validate that the registering session's cwd matches
      if (PROJECT_CWD && cwd !== PROJECT_CWD) {
        log(`register rejected: cwd ${cwd} does not match PROJECT_CWD ${PROJECT_CWD}`);
        return;
      }
      const worktrees = getWorktrees(cwd);
      const session: SessionInfo = { sessionId, cwd, branch: parsed.branch || "", repo: cwd.split("/").pop() || "", worktrees };
      const piClient = { ws, session };
      setPiClient(piClient);
      piClients.set(sessionId, piClient);
      log(`session registered: ${sessionId} (${session.repo})`);
      broadcastToBrowsers({ type: "session_added", session });
      // Auto-watch for browsers without a session (per-project mode); build payloads once lazily
      let diffJson: string | null = null;
      let commitsJson: string | null = null;
      for (const browser of browserClients) {
        const watchInfo = browserWatchMap.get(browser);
        if (!watchInfo?.sessionId) {
          browserWatchMap.set(browser, { sessionId, worktreePath: null });
          if (diffJson === null) {
            const { payload, defaultBranch } = buildDiffPayloadWithBranch(cwd, "branch");
            diffJson = JSON.stringify(payload);
            commitsJson = JSON.stringify({ type: "commits-list", commits: getLog(cwd, 30, defaultBranch) });
          }
          try { browser.send(diffJson); } catch { browserClients.delete(browser); continue; }
          try { browser.send(commitsJson!); } catch { browserClients.delete(browser); }
        }
      }
      for (const wt of session.worktrees) startWatching(sessionId, wt.path);
      if (session.worktrees.length === 0) startWatching(sessionId, session.cwd);
      return;
    }

    if (parsed.type === "update_info" && getPiClient()) {
      const piClient = getPiClient();
      const branchChanged = parsed.branch !== undefined && parsed.branch !== piClient.session.branch;
      if (parsed.branch !== undefined) piClient.session.branch = parsed.branch;
      broadcastToBrowsers({ type: "session_updated", session: piClient.session });
      if (branchChanged) {
        log(`branch changed for ${piClient.session.sessionId}: ${parsed.branch}`);
        notifyWatchingBrowsers(piClient.session.sessionId, [piClient.session.cwd]);
      }
      return;
    }
  },

  onPiClose: (piClient) => {
    stopAllWatchers(piClient.session.sessionId);
    piClients.delete(piClient.session.sessionId);
    log(`session disconnected: ${piClient.session.sessionId}`);
    broadcastToBrowsers({ type: "session_removed", sessionId: piClient.session.sessionId });
    // Last session gone — server exits
    if (piClients.size === 0) {
      log("last session disconnected — shutting down");
      process.exit(0);
    }
  },

  onBrowserWatch: (ws, watchId, client) => {
    if (client) {
      sendBranchDiffAndCommits(ws, client.session.cwd);
    }
    return { sessionId: watchId, worktreePath: null };  // pidiff stores {sessionId, worktreePath}
  },

  onBrowserConnect: (ws) => {
    browserWatchMap.set(ws, { sessionId: null, worktreePath: null });
    const sessions = Array.from(piClients.values()).map((c: any) => c.session);
    try { ws.send(JSON.stringify({ type: "sessions-list", sessions })); } catch {}
    // In per-project mode, auto-watch the first registered session
    if (PROJECT_CWD && sessions.length > 0) {
      const firstSession = sessions[0];
      browserWatchMap.set(ws, { sessionId: firstSession.sessionId, worktreePath: null });
      sendBranchDiffAndCommits(ws, firstSession.cwd);
    }
    // Refresh worktrees asynchronously if they drifted while no browser was connected
    void refreshWorktreesForAllSessions();
  },

  onBrowserMessage: (ws, parsed) => {
    // Watch a specific worktree within a session
    if (parsed.type === "watch-worktree") {
      const watchInfo = browserWatchMap.get(ws);
      if (!watchInfo?.sessionId) return;
      const client = piClients.get(watchInfo.sessionId);
      if (!client) return;

      const requestedPath = parsed.worktreePath || client.session.cwd;
      // Validate: only allow known worktree paths or session cwd
      const allowedPaths = new Set([
        path.resolve(client.session.cwd),
        ...client.session.worktrees.map((w: any) => path.resolve(w.path)),
      ]);
      const resolvedPath = path.resolve(requestedPath);
      if (!allowedPaths.has(resolvedPath)) {
        log(`watch-worktree rejected: ${requestedPath} not in allowed paths for session ${watchInfo.sessionId}`);
        return;
      }
      const worktreePath = resolvedPath;
      browserWatchMap.set(ws, { ...watchInfo, worktreePath });
      log(`browser watching worktree: ${worktreePath}`);

      sendBranchDiffAndCommits(ws, worktreePath);
      return;
    }

    // Request diffs for watched session
    if (parsed.type === "request-diffs") {
      const watchInfo = browserWatchMap.get(ws);
      if (!watchInfo?.sessionId) return;
      const client = piClients.get(watchInfo.sessionId);
      if (!client) return;

      const cwd = watchInfo.worktreePath || client.session.cwd;
      const mode: DiffMode = parsed.mode || "branch";
      const refs = parsed.fromRef && parsed.toRef ? { from: parsed.fromRef, to: parsed.toRef } : undefined;
      slog.debug("request-diffs", { cwd, mode, fromRef: refs?.from, toRef: refs?.to });
      const payload = buildDiffPayload(cwd, mode, refs);
      try { ws.send(JSON.stringify(payload)); } catch {}
      return;
    }

    // Request commits
    if (parsed.type === "request-commits") {
      const watchInfo = browserWatchMap.get(ws);
      if (!watchInfo?.sessionId) return;
      const client = piClients.get(watchInfo.sessionId);
      if (!client) return;

      const cwd = watchInfo.worktreePath || client.session.cwd;
      const commits = getLog(cwd, 30);
      try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
      return;
    }

    // Publish review comments → forward to the watched pi session
    if (parsed.type === "publish-review") {
      const watchInfo = browserWatchMap.get(ws);
      if (!watchInfo?.sessionId) return;
      const client = piClients.get(watchInfo.sessionId);
      if (client?.ws) {
        log(`review published for ${watchInfo.sessionId}: ${parsed.comments?.length || 0} comments`);
        try { client.ws.send(JSON.stringify(parsed)); } catch {}
      }
      return;
    }
  },
});

// ── Change detection — notify browsers ──────────────────────────────

// ── File watcher (chokidar) ─ real-time change detection ───────────────

function notifyWatchingBrowsers(sessionId: string, changedWorktrees: string[]): void {
  sendToMatchingBrowsers(
    (_browser, watchInfo) => watchInfo?.sessionId === sessionId,
    { type: "status_changed", sessionId, changedWorktrees },
  );
}

let _chokidar: any = null;
import("chokidar").then(m => { _chokidar = m; log("chokidar loaded"); }).catch(e => log(`chokidar load failed: ${e.message}`));
const activeWatchers = new Map<string, { watcher: any; debounceTimer: ReturnType<typeof setTimeout> | null }>();

const chokidarRetries = new Map<string, number>();
const MAX_CHOKIDAR_RETRIES = 10;

/** Gitignored paths for chokidar: whole top-level dirs plus nested prefixes. */
function getGitIgnoredDirs(worktreePath: string): GitIgnoredWatchFilter {
  try {
    const raw = execFileSync(GIT_BIN, ["ls-files", "-oi", "--directory", "--exclude-standard"], {
      cwd: worktreePath, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 5 * 1024 * 1024,
    }).trim();
    const filter = parseGitIgnoredWatchFilter(raw);
    slog.info("gitignored watch filter", { worktreePath, topLevel: [...filter.topLevel].join(",") || "(none)", nested: filter.nested.length });
    return filter;
  } catch (e: any) {
    slog.error("getGitIgnoredDirs failed", { worktreePath, err: e.message });
    return { topLevel: new Set(), nested: [] };
  }
}

/** Get the global gitignore file path (cached once per server lifetime). */
let cachedGlobalGitignore: string | null | undefined;
function getGlobalGitignore(): string | null {
  if (cachedGlobalGitignore !== undefined) return cachedGlobalGitignore;
  try {
    const result = execFileSync(GIT_BIN, ["config", "--global", "core.excludesfile"], {
      encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (result) {
      if (result.startsWith("~")) {
        const home = process.env.HOME;
        if (!home) {
          log("getGlobalGitignore: HOME unset, skipping tilde expansion");
          cachedGlobalGitignore = null;
          return null;
        }
        cachedGlobalGitignore = path.join(home, result.slice(1));
        return cachedGlobalGitignore;
      }
      cachedGlobalGitignore = result;
      return cachedGlobalGitignore;
    }
  } catch { log("getGlobalGitignore: no global core.excludesfile configured"); }
  cachedGlobalGitignore = null;
  return null;
}

function startWatching(sessionId: string, worktreePath: string) {
  const retryKey = `${sessionId}:${worktreePath}`;
  if (!_chokidar) {
    const retries = chokidarRetries.get(retryKey) || 0;
    if (retries >= MAX_CHOKIDAR_RETRIES) {
      slog.error("chokidar failed to load", { worktreePath, retries: MAX_CHOKIDAR_RETRIES });
      return;
    }
    chokidarRetries.set(retryKey, retries + 1);
    setTimeout(() => startWatching(sessionId, worktreePath), 1000 * Math.min(retries + 1, 5));
    return;
  }
  chokidarRetries.delete(retryKey);
  const key = `${sessionId}:${worktreePath}`;
  if (activeWatchers.has(key)) {
    slog.debug("startWatching already active", { worktreePath });
    return;
  }

  let gitIgnoredDirs = getGitIgnoredDirs(worktreePath);
  slog.info("starting chokidar watch", { worktreePath });

  const watcher = _chokidar.watch(worktreePath, {
    ignoreInitial: true,
    persistent: true,
    ignored: (filePath: string) => {
      const rel = path.relative(worktreePath, filePath);
      if (rel === "") return false;
      if (rel.startsWith("..")) return true;
      const relPosix = rel.split(path.sep).join("/");
      return isGitIgnoredRelPath(relPosix, gitIgnoredDirs);
    },
    depth: 20,
  });

  const state = { watcher, debounceTimer: null as ReturnType<typeof setTimeout> | null, gitignoreWatcher: null as any };
  activeWatchers.set(key, state);

  const onChange = () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      notifyWatchingBrowsers(sessionId, [worktreePath]);
    }, 500);
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", onChange);
  watcher.on("addDir", onChange);
  watcher.on("unlinkDir", onChange);

  // Watch .gitignore files for changes and refresh ignored dirs.
  // Note: refreshing gitIgnoredDirs only affects event filtering for future changes.
  // Chokidar won't start watching previously-ignored dirs that become un-ignored,
  // and won't release watchers for newly-ignored dirs (they just get filtered).
  // A pidiff restart is needed for full gitignore changes to take effect.
  const gitignoreFiles = [path.join(worktreePath, ".gitignore")];
  const globalGitignore = getGlobalGitignore();
  if (globalGitignore) gitignoreFiles.push(globalGitignore);

  try {
    const gitignoreWatcher = _chokidar.watch(gitignoreFiles, {
      ignoreInitial: true,
      persistent: true,
    });
    gitignoreWatcher.on("change", () => {
      slog.info("gitignore changed, refreshing ignored dirs", { worktreePath });
      gitIgnoredDirs = getGitIgnoredDirs(worktreePath);
    });
    state.gitignoreWatcher = gitignoreWatcher;
  } catch (e: any) { slog.warn("gitignore watcher setup failed", { err: e.message }); }
}

function stopWatching(sessionId: string, worktreePath: string) {
  const key = `${sessionId}:${worktreePath}`;
  const state = activeWatchers.get(key);
  if (state) {
    log(`stopping chokidar watch: ${worktreePath}`);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.watcher.close();
    if (state.gitignoreWatcher) state.gitignoreWatcher.close();
    activeWatchers.delete(key);
  }
}

function stopAllWatchers(sessionId: string) {
  for (const [key, state] of activeWatchers) {
    if (key.startsWith(`${sessionId}:`)) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.watcher.close();
      if (state.gitignoreWatcher) state.gitignoreWatcher.close();
      activeWatchers.delete(key);
    }
  }
}

// Periodically refresh worktree list asynchronously (skipped when no browser is connected)
let worktreeRefreshInFlight = false;
async function refreshWorktreesForAllSessions(): Promise<void> {
  if (worktreeRefreshInFlight || piClients.size === 0) return;
  worktreeRefreshInFlight = true;
  try {
    for (const [sessionId, client] of [...piClients.entries()]) {
      try {
        const freshWorktrees = await getWorktreesAsync(client.session.cwd);
        if (piClients.get(sessionId) !== client) continue;
        const oldFingerprint = client.session.worktrees.map((w: WorktreeInfo) => `${w.path}:${w.branch}`).sort().join("|");
        const newFingerprint = freshWorktrees.map(w => `${w.path}:${w.branch}`).sort().join("|");
        if (oldFingerprint !== newFingerprint) {
          // Start/stop watchers for new/removed worktrees
          const oldPaths = new Set(client.session.worktrees.map((w: WorktreeInfo) => w.path));
          const newPaths = new Set(freshWorktrees.map(w => w.path));
          for (const wt of freshWorktrees) {
            if (!oldPaths.has(wt.path)) startWatching(sessionId, wt.path);
          }
          for (const wt of client.session.worktrees) {
            if (!newPaths.has(wt.path)) stopWatching(sessionId, wt.path);
          }
          client.session.worktrees = freshWorktrees;
          broadcastToBrowsers({ type: "session_updated", session: client.session });
        }
      } catch (e: any) { slog.warn("worktreeRefresh error", { sessionId, err: e?.message }); }
    }
  } finally {
    worktreeRefreshInFlight = false;
  }
}

const worktreeRefreshInterval = setInterval(() => {
  if (browserClients.size === 0) return;
  void refreshWorktreesForAllSessions();
}, 10000);
if (worktreeRefreshInterval.unref) worktreeRefreshInterval.unref();

// ── Start ───────────────────────────────────────────────────────────

// Control files live in .pi/run — .pi/tmp is throwaway and may be swept (#1020).
const RUN_DIR = PROJECT_CWD ? path.join(PROJECT_CWD, ".pi", "run") : "";
const LEGACY_RUN_DIR = PROJECT_CWD ? path.join(PROJECT_CWD, ".pi", "tmp") : "";
const PID_FILE = RUN_DIR ? path.join(RUN_DIR, "pidiff.pid") : "";

/** Drop the pre-#1020 PID file, but never while that daemon is still running. */
function removeLegacyPidFile(): void {
  if (!LEGACY_RUN_DIR) return;
  const legacy = path.join(LEGACY_RUN_DIR, "pidiff.pid");
  try {
    const pid = parseInt(fs.readFileSync(legacy, "utf-8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); return; } catch (e: any) { if (e?.code === "EPERM") return; }
    }
    fs.unlinkSync(legacy);
    log(`legacy PID file removed: ${legacy}`);
  } catch {}
}

// Write PID file for lockfile-based management (before start so /pidiff stop works during startup)
if (PID_FILE) {
  try {
    if (!fs.existsSync(RUN_DIR)) fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
    log(`PID file written: ${PID_FILE} (PID ${process.pid})`);
    removeLegacyPidFile();
  } catch (e: any) { log(`PID file write error: ${e.message}`); }
}

// Clean PID file on exit to prevent stale PID issues
process.on("exit", () => {
  if (PID_FILE) {
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
});

start();
