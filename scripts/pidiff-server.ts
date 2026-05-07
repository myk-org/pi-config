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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { serveUi } from "./serve-ui.ts";

const DEFAULT_PORT = 19290;
const port = parseInt(process.env.PI_PIDIFF_PORT || "", 10) || DEFAULT_PORT;

function log(msg: string) {
  console.log(`${new Date().toISOString()} [pidiff] ${msg}`);
}

// ── Git helpers ─────────────────────────────────────────────────────

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] as const, maxBuffer: 10 * 1024 * 1024 };

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, { ...GIT_OPTS, cwd }).trim();
}

function getDefaultRemoteBranch(cwd: string): string {
  try {
    const ref = gitExec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    return ref.replace("refs/remotes/", "");
  } catch {
    for (const name of ["origin/main", "origin/master", "origin/develop"]) {
      try { gitExec(["rev-parse", "--verify", name], cwd); return name; } catch {}
    }
    return "";
  }
}

function getBranch(cwd: string): string {
  try { return gitExec(["branch", "--show-current"], cwd); } catch { return ""; }
}

function getStatus(cwd: string): { dirty: boolean; changes: number } {
  try {
    const s = gitExec(["status", "--porcelain"], cwd);
    const changes = s ? s.split("\n").length : 0;
    return { dirty: changes > 0, changes };
  } catch { return { dirty: false, changes: 0 }; }
}

function getDiff(cwd: string): { staged: string; unstaged: string } {
  try {
    const staged = gitExec(["diff", "--staged"], cwd);
    let unstaged = gitExec(["diff"], cwd);

    // Include untracked files in the unstaged diff
    try {
      const untrackedRaw = gitExec(["ls-files", "--others", "--exclude-standard"], cwd);
      if (untrackedRaw) {
        const untrackedFiles = untrackedRaw.split("\n").filter(Boolean);
        for (const file of untrackedFiles) {
          try {
            const content = execFileSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
              cwd, encoding: "utf-8", timeout: 3000,
              stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024,
            }).trim();
            if (content) unstaged += (unstaged ? "\n" : "") + content;
          } catch (e: any) {
            // git diff --no-index exits with code 1 when files differ (expected)
            if (e.stdout) unstaged += (unstaged ? "\n" : "") + e.stdout.toString().trim();
          }
        }
      }
    } catch (e: any) {
      log(`untracked files diff error: ${e.message}`);
    }

    return { staged, unstaged };
  } catch (e: any) { log(`getDiff error: ${e.message}`); return { staged: "", unstaged: "" }; }
}

function getBranchDiff(cwd: string): string {
  try {
    const defaultBranch = getDefaultRemoteBranch(cwd);
    if (!defaultBranch) return "";
    const base = gitExec(["merge-base", defaultBranch, "HEAD"], cwd);
    if (!base) return "";
    return execFileSync("git", ["diff", base, "HEAD"], {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch (e: any) { log(`getBranchDiff error: ${e.message}`); return ""; }
}

function getCommitDiff(cwd: string, fromRef: string, toRef: string): string {
  try {
    // Validate refs are hex hashes to prevent flag injection
    const hexRef = /^[a-fA-F0-9]{4,40}$/;
    if (!hexRef.test(fromRef) || !hexRef.test(toRef)) {
      log(`getCommitDiff: invalid ref format: ${fromRef} / ${toRef}`);
      return "";
    }
    return execFileSync("git", ["diff", "--", fromRef, toRef], {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch (e: any) { log(`getCommitDiff error: ${e.message}`); return ""; }
}

function getLog(cwd: string, count: number = 30): Array<{ hash: string; short: string; subject: string; date: string }> {
  count = Math.min(count, 100); // Clamp to prevent DoS
  try {
    const defaultBranch = getDefaultRemoteBranch(cwd);
    let args = ["log", `--format=%H%n%h%n%s%n%ai`, `-${count}`];
    if (defaultBranch) {
      args = ["log", `--format=%H%n%h%n%s%n%ai`, `-${count}`, `${defaultBranch}..HEAD`];
    }
    const raw = gitExec(args, cwd);
    if (!raw) return [];
    const lines = raw.split("\n");
    const commits: Array<{ hash: string; short: string; subject: string; date: string }> = [];
    for (let i = 0; i + 3 < lines.length; i += 4) {
      commits.push({ hash: lines[i], short: lines[i + 1], subject: lines[i + 2], date: lines[i + 3] });
    }
    return commits;
  } catch (e: any) { log(`getLog error: ${e.message}`); return []; }
}

// ── Diff modes ──────────────────────────────────────────────────────

type DiffMode = "working" | "branch" | "commits";

// Cache per-cwd
const branchDiffCache = new Map<string, { data: string; ts: number }>();
const CACHE_TTL = 5000;

function getCachedBranchDiff(cwd: string): string {
  const cached = branchDiffCache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const data = getBranchDiff(cwd);
  branchDiffCache.set(cwd, { data, ts: Date.now() });
  return data;
}

function buildDiffPayload(cwd: string, mode: DiffMode, refs?: { from: string; to: string }): object {
  const branch = getBranch(cwd);
  const status = getStatus(cwd);

  if (mode === "working") {
    const diff = status.dirty ? getDiff(cwd) : { staged: "", unstaged: "" };
    return { type: "diff_update", mode: "working", staged: diff.staged, unstaged: diff.unstaged, committed: "", branch };
  }

  if (mode === "branch") {
    const committed = getCachedBranchDiff(cwd);
    const working = status.dirty ? getDiff(cwd) : { staged: "", unstaged: "" };
    return { type: "diff_update", mode: "branch", committed, staged: working.staged, unstaged: working.unstaged, branch };
  }

  if (mode === "commits" && refs) {
    const committed = getCommitDiff(cwd, refs.from, refs.to);
    return { type: "diff_update", mode: "commits", committed, staged: "", unstaged: "", branch, fromRef: refs.from, toRef: refs.to };
  }

  return { type: "diff_update", mode, staged: "", unstaged: "", committed: "", branch };
}

// ── Session state ───────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  cwd: string;
  branch: string;
  repo: string; // basename of cwd
}

interface PiClient {
  ws: any;
  session: SessionInfo;
}

const piClients = new Map<string, PiClient>();
const browserClients = new Set<any>();
const browserWatchMap = new WeakMap<any, string | null>(); // sessionId being watched

// ── HTTP Server ─────────────────────────────────────────────────────

const UI_DIR = path.join(path.dirname(process.argv[1] || __filename), "..", "extensions", "orchestrator", "pidiff-ui", "dist");

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", `http://localhost:${port}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port, sessions: piClients.size }));
    return;
  }

  if (url.pathname === "/api/sessions") {
    const sessions = Array.from(piClients.values()).map(c => c.session);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  serveUi(url.pathname, res, { uiDir: UI_DIR, name: "pidiff-ui", log });
});

// ── WebSocket ───────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const WebSocket = _require("ws");

// Pi session clients
const piWss = new WebSocket.Server({ noServer: true });
piWss.on("connection", (ws: any) => {
  let piClient: PiClient | null = null;

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "register") {
        const sessionId = parsed.sessionId || `${parsed.pid}:${parsed.cwd}`;
        const session: SessionInfo = {
          sessionId,
          cwd: parsed.cwd || "",
          branch: parsed.branch || "",
          repo: (parsed.cwd || "").split("/").pop() || "",
        };
        piClient = { ws, session };
        piClients.set(sessionId, piClient);
        log(`session registered: ${sessionId} (${session.repo})`);
        broadcastToBrowsers({ type: "session_added", session });
        return;
      }

      if (parsed.type === "update_info" && piClient) {
        if (parsed.branch !== undefined) piClient.session.branch = parsed.branch;
        broadcastToBrowsers({ type: "session_updated", session: piClient.session });
        return;
      }
    } catch (e: any) { log(`pi message error: ${e.message}`); }
  });

  ws.on("close", () => {
    if (piClient) {
      piClients.delete(piClient.session.sessionId);
      statusCache.delete(piClient.session.sessionId);
      branchDiffCache.delete(piClient.session.cwd);
      log(`session disconnected: ${piClient.session.sessionId}`);
      broadcastToBrowsers({ type: "session_removed", sessionId: piClient.session.sessionId });
    }
  });

  ws.on("error", () => {
    if (piClient) {
      piClients.delete(piClient.session.sessionId);
      broadcastToBrowsers({ type: "session_removed", sessionId: piClient.session.sessionId });
    }
  });
});

// Browser clients
const browserWss = new WebSocket.Server({ noServer: true });
browserWss.on("connection", (ws: any) => {
  browserClients.add(ws);
  browserWatchMap.set(ws, null);
  log(`browser connected (total: ${browserClients.size})`);

  // Send session list
  const sessions = Array.from(piClients.values()).map(c => c.session);
  try { ws.send(JSON.stringify({ type: "sessions-list", sessions })); } catch {}

  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString());

      // Watch a session
      if (parsed.type === "watch") {
        const watchId = parsed.sessionId ?? null;
        browserWatchMap.set(ws, watchId);
        log(`browser watching: ${watchId}`);

        if (watchId) {
          const client = piClients.get(watchId);
          if (client) {
            // Send initial branch diff
            const payload = buildDiffPayload(client.session.cwd, "branch");
            try { ws.send(JSON.stringify(payload)); } catch {}
            // Send commits
            const commits = getLog(client.session.cwd, 30);
            try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
          }
        }
        return;
      }

      // Request diffs for watched session
      if (parsed.type === "request-diffs") {
        const watchId = browserWatchMap.get(ws);
        if (!watchId) return;
        const client = piClients.get(watchId);
        if (!client) return;

        const mode: DiffMode = parsed.mode || "branch";
        const refs = parsed.fromRef && parsed.toRef ? { from: parsed.fromRef, to: parsed.toRef } : undefined;
        const payload = buildDiffPayload(client.session.cwd, mode, refs);
        try { ws.send(JSON.stringify(payload)); } catch {}
        return;
      }

      // Request commits
      if (parsed.type === "request-commits") {
        const watchId = browserWatchMap.get(ws);
        if (!watchId) return;
        const client = piClients.get(watchId);
        if (!client) return;

        const commits = getLog(client.session.cwd, 30);
        try { ws.send(JSON.stringify({ type: "commits-list", commits })); } catch {}
        return;
      }

      // Publish review comments → forward to the watched pi session
      if (parsed.type === "publish-review") {
        const watchId = browserWatchMap.get(ws);
        if (!watchId) return;
        const client = piClients.get(watchId);
        if (client?.ws) {
          log(`review published for ${watchId}: ${parsed.comments?.length || 0} comments`);
          try { client.ws.send(JSON.stringify(parsed)); } catch {}
        }
        return;
      }
    } catch (e: any) { log(`browser message error: ${e.message}`); }
  });

  ws.on("close", () => {
    browserClients.delete(ws);
    log(`browser disconnected (total: ${browserClients.size})`);
  });
  ws.on("error", () => browserClients.delete(ws));
});

function broadcastToBrowsers(event: object) {
  const data = JSON.stringify(event);
  for (const browser of browserClients) {
    try { browser.send(data); } catch { browserClients.delete(browser); }
  }
}

// Route WebSocket upgrades
server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
  // Validate Origin — only allow localhost connections
  const origin = req.headers.origin || "";
  if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
    log(`rejected WebSocket upgrade from origin: ${origin}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url || "/", `http://localhost`);
  if (url.pathname === "/ws/browser") {
    browserWss.handleUpgrade(req, socket, head, (ws: any) => browserWss.emit("connection", ws, req));
  } else if (url.pathname === "/ws/pi") {
    piWss.handleUpgrade(req, socket, head, (ws: any) => piWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── Change detection — notify browsers ──────────────────────────────

const statusCache = new Map<string, string>();
let changeDetectorRunning = false;

async function checkForChanges() {
  if (browserClients.size === 0 || changeDetectorRunning) return;
  changeDetectorRunning = true;
  try {
    for (const [sessionId, client] of piClients) {
      const cwd = client.session.cwd;
      try {
        const [statusResult, branchResult] = await Promise.all([
          execFileAsync("git", ["status", "--porcelain"], { cwd, timeout: 3000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: "" })),
          execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 3000 }).catch(() => ({ stdout: "" })),
        ]);
        const statusOut = (statusResult.stdout || "").trim();
        const changes = statusOut ? statusOut.split("\n").length : 0;
        const dirty = changes > 0;
        const branch = (branchResult.stdout || "").trim();
        const hash = `${branch}:${dirty}:${changes}`;
        const prev = statusCache.get(sessionId);
        if (hash === prev) continue;
        statusCache.set(sessionId, hash);

        client.session.branch = branch;

        const msg = JSON.stringify({ type: "status_changed", sessionId, dirty, changes, branch });
        for (const browser of browserClients) {
          if (browserWatchMap.get(browser) === sessionId) {
            try { browser.send(msg); } catch {}
          }
        }
      } catch {}
    }
  } finally {
    changeDetectorRunning = false;
  }
}

const changeDetector = setInterval(checkForChanges, 5000);
if (changeDetector.unref) changeDetector.unref();

// Ping pi clients
const pingInterval = setInterval(() => {
  for (const [, client] of piClients) {
    if (client.ws) { try { client.ws.ping(); } catch {} }
  }
}, 30000);
if (pingInterval.unref) pingInterval.unref();

// ── Start ───────────────────────────────────────────────────────────

server.listen(port, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${port}`);
  console.log(`http://127.0.0.1:${port}`);
});

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    log(`port ${port} already in use — daemon likely already running`);
    process.exit(0);
  }
  log(`server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGHUP", () => {});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
