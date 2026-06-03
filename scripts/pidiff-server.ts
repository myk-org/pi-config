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

function log(msg: string) {
  console.log(`${new Date().toISOString()} [pidiff] ${msg}`);
}

// ── Git helpers ─────────────────────────────────────────────────────

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] as const, maxBuffer: 10 * 1024 * 1024 };

// Resolve git binary — prefer PI_GIT_BIN env var (set by the spawning extension which has the correct PATH)
let GIT_BIN = process.env.PI_GIT_BIN || "git";
let gitBinResolved = false;

function resolveGitBin(): string {
  // 1. PI_GIT_BIN from env (set by extension with correct PATH)
  if (process.env.PI_GIT_BIN) {
    try { execFileSync(process.env.PI_GIT_BIN, ["--version"], { stdio: "ignore" }); GIT_BIN = process.env.PI_GIT_BIN; gitBinResolved = true; return GIT_BIN; } catch {}
  }
  // 2. Try "git" on PATH
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); GIT_BIN = "git"; gitBinResolved = true; return GIT_BIN; } catch {}
  log("WARNING: git binary not found — set PI_GIT_BIN or ensure git is in PATH");
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

function getWorkingTreeFiles(cwd: string): { staged: FileContentsData[]; unstaged: FileContentsData[] } {
  const staged: FileContentsData[] = [];
  const unstaged: FileContentsData[] = [];
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
  return { staged, unstaged };
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

const browserWatchMap = new WeakMap<any, { sessionId: string | null; worktreePath: string | null }>();

const { piClients, browserClients, broadcastToBrowsers, start } = createDaemonServer({
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
      const worktrees = getWorktrees(cwd);
      const session: SessionInfo = { sessionId, cwd, branch: parsed.branch || "", repo: cwd.split("/").pop() || "", worktrees };
      const piClient = { ws, session };
      setPiClient(piClient);
      piClients.set(sessionId, piClient);
      log(`session registered: ${sessionId} (${session.repo})`);
      broadcastToBrowsers({ type: "session_added", session });
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
  },

  onBrowserConnect: (ws) => {
    browserWatchMap.set(ws, { sessionId: null, worktreePath: null });
    const sessions = Array.from(piClients.values()).map((c: any) => c.session);
    try { ws.send(JSON.stringify({ type: "sessions-list", sessions })); } catch {}
  },

  onBrowserMessage: (ws, parsed) => {
    // Watch a session
    if (parsed.type === "watch") {
      const watchId = parsed.sessionId ?? null;
      browserWatchMap.set(ws, { sessionId: watchId, worktreePath: null });
      log(`browser watching: ${watchId}`);

      if (watchId) {
        const client = piClients.get(watchId);
        if (client) {
          const payload = buildDiffPayload(client.session.cwd, "branch");
          try { ws.send(JSON.stringify(payload)); } catch {}
          const commits = getLog(client.session.cwd, 30);
          try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
        }
      }
      return;
    }

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

  log(`starting chokidar watch: ${worktreePath}`);
  const watcher = _chokidar.watch(worktreePath, {
    ignoreInitial: true,
    persistent: true,
    ignored: (filePath: string) => {
      const rel = path.relative(worktreePath, filePath);
      if (rel === "") return false; // watch root itself — don't ignore
      if (rel.startsWith("..")) return true; // outside watch root — ignore
      const first = rel.split(path.sep)[0];
      return first === ".git" || first === "node_modules" || first === ".worktrees" || first === ".venv" || first === "dist" || first === "__pycache__";
    },
    depth: 20,
  });

  const state = { watcher, debounceTimer: null as ReturnType<typeof setTimeout> | null };
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
}

function stopWatching(sessionId: string, worktreePath: string) {
  const key = `${sessionId}:${worktreePath}`;
  const state = activeWatchers.get(key);
  if (state) {
    log(`stopping chokidar watch: ${worktreePath}`);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.watcher.close();
    activeWatchers.delete(key);
  }
}

function stopAllWatchers(sessionId: string) {
  for (const [key, state] of activeWatchers) {
    if (key.startsWith(`${sessionId}:`)) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.watcher.close();
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

start();
