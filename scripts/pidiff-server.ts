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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDaemonServer } from "./daemon-shared.ts";

const DEFAULT_PORT = 19290;
const port = parseInt(process.env.PI_PIDIFF_PORT || "", 10) || DEFAULT_PORT;

const PROJECT_CWD = process.env.PI_PIDIFF_CWD || "";
if (!PROJECT_CWD) {
  console.log(`${new Date().toISOString()} [pidiff] WARNING: PI_PIDIFF_CWD not set — server will only work when sessions register`);
}

function log(msg: string) {
  console.log(`${new Date().toISOString()} [pidiff] ${msg}`);
}

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

interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

function getWorktrees(cwd: string): WorktreeInfo[] {
  try {
    const raw = execFileSync(GIT_BIN, ["worktree", "list", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024,
    });
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    const pushIfValid = () => {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || "(unknown)",
          head: current.head || "",
          isMain: current.isMain || false,
        });
      }
    };
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        pushIfValid();
        current = { path: line.slice(9), isMain: worktrees.length === 0 };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        // "branch refs/heads/main" → "main"
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "detached") {
        current.branch = `(detached)`;
      } else if (line === "") {
        pushIfValid();
        current = {};
      }
    }
    pushIfValid();
    return worktrees;
  } catch (e: any) { log(`getWorktrees error: ${e.message}`); return []; }
}

function getStatus(cwd: string): { dirty: boolean; changes: number } {
  try {
    const s = gitExec(["status", "--porcelain"], cwd);
    const changes = s ? s.split("\n").length : 0;
    return { dirty: changes > 0, changes };
  } catch { return { dirty: false, changes: 0 }; }
}



function getLog(cwd: string, count: number = 30): Array<{ hash: string; short: string; subject: string; date: string }> {
  count = Math.min(count, 100); // Clamp to prevent DoS
  try {
    const defaultBranch = getDefaultRemoteBranch(cwd);
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

interface FileContentsData {
  name: string;
  oldContents: string;
  newContents: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

function parseDiffLines(
  raw: string,
  getOld: (oldName: string) => string,
  getNew: (fileName: string) => string,
): FileContentsData[] {
  const results: FileContentsData[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const statusChar = parts[0][0];
    const fileName = parts.length > 2 ? parts[2] : parts[1];
    const oldName = parts.length > 2 ? parts[1] : fileName;
    let status: FileContentsData["status"] = "modified";
    if (statusChar === "A") status = "added";
    else if (statusChar === "D") status = "deleted";
    else if (statusChar === "R") status = "renamed";
    let oldContents = "";
    let newContents = "";
    try { if (status !== "added") oldContents = getOld(oldName); } catch {}
    try { if (status !== "deleted") newContents = getNew(fileName); } catch {}
    results.push({ name: fileName, oldContents, newContents, status });
  }
  return results;
}

const gitShowOpts = (cwd: string) => ({ cwd, encoding: "utf-8" as const, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] as const, maxBuffer: 5 * 1024 * 1024 });

function getChangedFiles(cwd: string, baseRef: string, headRef: string = "HEAD"): FileContentsData[] {
  try {
    const raw = gitExec(["diff", "--name-status", baseRef, headRef], cwd);
    if (!raw) return [];
    const opts = gitShowOpts(cwd);
    return parseDiffLines(raw,
      (oldName) => execFileSync(GIT_BIN, ["show", `${baseRef}:${oldName}`], opts),
      (fileName) => execFileSync(GIT_BIN, ["show", `${headRef}:${fileName}`], opts),
    );
  } catch (e: any) { log(`getChangedFiles error (base=${baseRef} head=${headRef}): ${e.message}`); return []; }
}

function getStagedFiles(cwd: string): FileContentsData[] {
  const staged: FileContentsData[] = [];
  const opts = gitShowOpts(cwd);
  try {
    const stagedRaw = gitExec(["diff", "--name-status", "--staged"], cwd);
    if (stagedRaw) {
      staged.push(...parseDiffLines(stagedRaw,
        (oldName) => execFileSync(GIT_BIN, ["show", `HEAD:${oldName}`], opts),
        (fileName) => execFileSync(GIT_BIN, ["show", `:${fileName}`], opts),
      ));
    }
  } catch (e: any) { log(`getWorkingTreeFiles staged error: ${e.message}`); }
  return staged;
}

function getUnstagedFiles(cwd: string): FileContentsData[] {
  const unstaged: FileContentsData[] = [];
  const opts = gitShowOpts(cwd);
  try {
    const unstagedRaw = gitExec(["diff", "--name-status"], cwd);
    if (unstagedRaw) {
      unstaged.push(...parseDiffLines(unstagedRaw,
        (oldName) => execFileSync(GIT_BIN, ["show", `:${oldName}`], opts),
        (fileName) => fs.readFileSync(path.join(cwd, fileName), "utf-8"),
      ));
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

function buildDiffPayload(cwd: string, mode: DiffMode, refs?: { from: string; to: string }): object {
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
    return { type: "diff_update", mode: "branch", committed, staged: working.staged, unstaged: working.unstaged, branch };
  }

  if (mode === "commits" && refs) {
    const committed = getChangedFiles(cwd, refs.from, refs.to);
    return { type: "diff_update", mode: "commits", committed, staged: [], unstaged: [], branch, fromRef: refs.from, toRef: refs.to };
  }

  return { type: "diff_update", mode, committed: [], staged: [], unstaged: [], branch };
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

const { piClients, browserClients, browserWatchMap, broadcastToBrowsers, start } = createDaemonServer({
  port,
  uiDir: path.join(path.dirname(process.argv[1] || __filename), "..", "extensions", "pidiff", "pidiff-ui", "dist"),
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
      // Auto-watch for browsers without a session (per-project mode)
      for (const browser of browserClients) {
        const watchInfo = browserWatchMap.get(browser);
        if (!watchInfo?.sessionId) {
          browserWatchMap.set(browser, { sessionId, worktreePath: null });
          const payload = buildDiffPayload(cwd, "branch");
          try { browser.send(JSON.stringify(payload)); } catch {}
          const commits = getLog(cwd, 30);
          try { browser.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
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
    // Start idle shutdown timer when last pi session disconnects
    if (piClients.size === 0) {
      const delay = browserClients.size === 0 ? 5000 : 30000;
      log(`last pi session disconnected — shutting down in ${delay / 1000}s (${browserClients.size} browsers)`);
      const shutdownTimer = setTimeout(() => {
        if (piClients.size === 0 && browserClients.size === 0) {
          log("idle shutdown — no sessions or browsers");
          process.exit(0);
        } else if (piClients.size === 0) {
          log("idle shutdown — no sessions reconnected, closing remaining browsers");
          process.exit(0);
        } else {
          log("shutdown cancelled — session reconnected");
        }
      }, delay);
      if (shutdownTimer.unref) shutdownTimer.unref();
    }
  },

  onBrowserWatch: (ws, watchId, client) => {
    if (client) {
      const payload = buildDiffPayload(client.session.cwd, "branch");
      try { ws.send(JSON.stringify(payload)); } catch {}
      const commits = getLog(client.session.cwd, 30);
      try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
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
      const payload = buildDiffPayload(firstSession.cwd, "branch");
      try { ws.send(JSON.stringify(payload)); } catch {}
      const commits = getLog(firstSession.cwd, 30);
      try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
    }
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

      const payload = buildDiffPayload(worktreePath, "branch");
      try { ws.send(JSON.stringify(payload)); } catch {}
      const commits = getLog(worktreePath, 30);
      try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
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
  const msg = JSON.stringify({ type: "status_changed", sessionId, changedWorktrees });
  for (const browser of browserClients) {
    const watchInfo = browserWatchMap.get(browser);
    if (watchInfo?.sessionId === sessionId) {
      try { browser.send(msg); } catch {}
    }
  }
}

let _chokidar: any = null;
import("chokidar").then(m => { _chokidar = m; log("chokidar loaded"); }).catch(e => log(`chokidar load failed: ${e.message}`));
const activeWatchers = new Map<string, { watcher: any; debounceTimer: ReturnType<typeof setTimeout> | null }>();

const chokidarRetries = new Map<string, number>();
const MAX_CHOKIDAR_RETRIES = 10;

/** Get top-level gitignored directories for a worktree path. */
function getGitIgnoredDirs(worktreePath: string): Set<string> {
  const dirs = new Set<string>();
  try {
    const raw = execFileSync(GIT_BIN, ["ls-files", "-oi", "--directory", "--exclude-standard"], {
      cwd: worktreePath, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 5 * 1024 * 1024,
    }).trim();
    if (raw) {
      for (const line of raw.split("\n")) {
        const trimmed = line.replace(/\/$/, "");
        if (trimmed) {
          const topLevel = trimmed.split("/")[0];
          if (topLevel) dirs.add(topLevel);
        }
      }
    }
  } catch (e: any) { log(`getGitIgnoredDirs error for ${worktreePath}: ${e.message}`); }
  return dirs;
}

/** Get the global gitignore file path. */
function getGlobalGitignore(): string | null {
  try {
    const result = execFileSync(GIT_BIN, ["config", "--global", "core.excludesfile"], {
      encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (result) {
      if (result.startsWith("~")) {
        const home = process.env.HOME;
        if (!home) { log("getGlobalGitignore: HOME unset, skipping tilde expansion"); return null; }
        return path.join(home, result.slice(1));
      }
      return result;
    }
  } catch { log("getGlobalGitignore: no global core.excludesfile configured"); }
  return null;
}

function startWatching(sessionId: string, worktreePath: string) {
  const retryKey = `${sessionId}:${worktreePath}`;
  if (!_chokidar) {
    const retries = chokidarRetries.get(retryKey) || 0;
    if (retries >= MAX_CHOKIDAR_RETRIES) { log(`chokidar failed to load after ${MAX_CHOKIDAR_RETRIES} retries, giving up on ${worktreePath}`); return; }
    chokidarRetries.set(retryKey, retries + 1);
    setTimeout(() => startWatching(sessionId, worktreePath), 1000 * Math.min(retries + 1, 5));
    return;
  }
  chokidarRetries.delete(retryKey);
  const key = `${sessionId}:${worktreePath}`;
  if (activeWatchers.has(key)) return;

  // Load gitignored directories
  let gitIgnoredDirs = getGitIgnoredDirs(worktreePath);
  log(`starting chokidar watch: ${worktreePath} (${gitIgnoredDirs.size} gitignored dirs: ${[...gitIgnoredDirs].join(", ")})`);

  // Performance-critical dirs always ignored (avoid recursing into huge dirs)
  const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

  const watcher = _chokidar.watch(worktreePath, {
    ignoreInitial: true,
    persistent: true,
    ignored: (filePath: string) => {
      const rel = path.relative(worktreePath, filePath);
      if (rel === "") return false;
      if (rel.startsWith("..")) return true;
      const first = rel.split(path.sep)[0];
      return ALWAYS_IGNORED.has(first) || gitIgnoredDirs.has(first);
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
      log(`gitignore changed for ${worktreePath}, refreshing ignored dirs`);
      gitIgnoredDirs = getGitIgnoredDirs(worktreePath);
      log(`refreshed gitignored dirs: ${[...gitIgnoredDirs].join(", ")}`);
    });
    state.gitignoreWatcher = gitignoreWatcher;
  } catch (e: any) { log(`gitignore watcher setup failed: ${e.message}`); }
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

// Periodically refresh worktree list (worktrees may be added/removed)
const worktreeRefreshInterval = setInterval(() => {
  for (const [sessionId, client] of piClients) {
    try {
      const freshWorktrees = getWorktrees(client.session.cwd);
      const oldFingerprint = client.session.worktrees.map(w => `${w.path}:${w.branch}`).sort().join("|");
      const newFingerprint = freshWorktrees.map(w => `${w.path}:${w.branch}`).sort().join("|");
      if (oldFingerprint !== newFingerprint) {
        // Start/stop watchers for new/removed worktrees
        const oldPaths = new Set(client.session.worktrees.map(w => w.path));
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
    } catch (e: any) { log(`worktreeRefresh error for ${sessionId}: ${e.message}`); }
  }
}, 10000);
if (worktreeRefreshInterval.unref) worktreeRefreshInterval.unref();

// ── Start ───────────────────────────────────────────────────────────

// Write PID file for lockfile-based management (before start so /pidiff stop works during startup)
if (PROJECT_CWD) {
  const pidDir = path.join(PROJECT_CWD, ".pi", "tmp");
  try {
    if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "pidiff.pid"), String(process.pid), { mode: 0o600 });
    log(`PID file written: ${pidDir}/pidiff.pid (PID ${process.pid})`);
  } catch (e: any) { log(`PID file write error: ${e.message}`); }
}

// Clean PID file on exit to prevent stale PID issues
process.on("exit", () => {
  if (PROJECT_CWD) {
    try { fs.unlinkSync(path.join(PROJECT_CWD, ".pi", "tmp", "pidiff.pid")); } catch {}
  }
});

start();
