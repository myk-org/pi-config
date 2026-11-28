/**
 * Loopback-only read-only HTTP JSON API surface for PiDash (`/api/*`).
 *
 * Exposes 15 authoritative read-only endpoints (plus preserved `/api/podman-build-status`)
 * for external scripts, status bars, and dashboards without requiring them to scrape
 * internal `.pi/` files:
 *   1.  GET /api/peers?project=<slug|*>&format=array
 *   2.  GET /api/worktrees?cwd=<repo>
 *   3.  GET /api/tasks?cwd=<repo>&session=<id>&assignee=<user|llm|all>
 *   4.  GET /api/agents?session=<id>
 *   5.  GET /api/crons?cwd=<repo>
 *   6.  GET /api/lsp?cwd=<repo>
 *   7.  GET /api/settings?cwd=<repo>&category=<cat>&only_overrides=true
 *   8.  GET /api/memory?cwd=<repo>
 *   9.  GET /api/review?cwd=<repo>
 *   10. GET /api/trail?cwd=<repo>&session=<id>
 *   11. GET /api/skills?cwd=<repo>
 *   12. GET /api/daemons?cwd=<repo>
 *   13. GET /api/security?cwd=<repo>
 *   14. GET /api/version
 *   15. GET /api/status?cwd=<repo>&project=<slug|*>
 *   +   GET /api/podman-build-status
 *
 * Security & runtime invariants:
 * - Strictly loopback-only (`isLoopbackAddress`, valid loopback `Host` header to prevent
 *   DNS rebinding, and loopback-only `Origin` header when present — HTTP 403 otherwise).
 * - Strictly GET-only (HTTP 405 with `Allow: GET` for non-GET methods, including OPTIONS).
 * - Strictly read-only: SQLite databases opened with `{ readOnly: true }`, zero LSP
 *   spawning, zero LLM/MCP/external network calls, zero directory/DB/marker creation or
 *   legacy migration on missing `.pi/` state, zero secrets or private tool/prompt outputs.
 * - Standalone daemon safe: zero runtime imports from `@earendil-works/*` or `typebox`.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createLogger } from "../extensions/shared/logger.ts";
import { MIN_PI_VERSION, getPiVersion } from "../extensions/shared/pi-version.ts";
import { ComsRegistry, isRegistryRowAlive, resolveComsDir } from "../extensions/coms/coms-registry.ts";
import { pickSupervisionRecord } from "../extensions/coms/coms-registry-core.ts";
import { readBuildStatus } from "./podman-peer-image.mjs";
import { isGitRepo, listWorktreesCheckedAsync, matchPathToWorktrees, type WorktreeEntry } from "../extensions/orchestrator/git-helpers.ts";
import { TaskStore, resolveStorePath } from "../extensions/pitasks/task-store.ts";
import { readDurableCronStoreOutcome } from "../extensions/orchestrator/cron-store.ts";
import {
  BUILTIN_LSP_SERVERS,
  buildLspStartupSummary,
  getDefaultLspBrokerRunDir,
  getLspBrokerSocketPath,
  resolveTrustedLspEnabled,
  resolveTrustedLspServers,
  sendBrokerRequest,
} from "../extensions/orchestrator/lsp.ts";
import {
  SETTINGS_KEYS,
  findSettingsFile,
  getCachedSettingsLayers,
  getSetting,
  parseSettingsFile,
  tryResolveMainCheckoutRoot,
} from "../extensions/orchestrator/project-settings.ts";
import {
  buildSettingBreakdown,
  sanitizeSettingValueForModel,
  type SettingBreakdown,
} from "../extensions/orchestrator/settings-tui-helpers.ts";
import { getMemoryTokenBudget } from "../extensions/orchestrator/situation-report.ts";
import { canonicalTopicLine, parseTopicLine } from "../extensions/orchestrator/memory-line.ts";
import { entryHash } from "../extensions/orchestrator/memory-scoring.ts";
import { parsePromotionsMarkdown } from "../extensions/orchestrator/promotion-queue.ts";
import type { ReviewState, ReviewSubject } from "../extensions/orchestrator/pi-config-review-state.ts";
import {
  getApprovalHmacKeyPath,
  readApprovalHmacKey,
  resolveProjectDbIdentity,
  verifyApprovalSignature,
} from "../extensions/orchestrator/restricted-folders.ts";
import {
  isValidExactHostname,
  loadToolPermissionLayers,
  verifyHostApprovalSignature,
} from "../extensions/orchestrator/tool-permissions.ts";
import { MAX_SNAPSHOT_STACK } from "../extensions/orchestrator/snapshots.ts";
import { resolveWorktreeRoot } from "../extensions/orchestrator/utils.ts";
import {
  isLoopbackAddress,
  type ActiveAsyncAgentInfo,
  type PiClient,
} from "./pidash-session-state.ts";

const log = createLogger("pidash-api");

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const SKILL_MAINTENANCE_MARKER_RE = /^\s*skill-maintenance\s*:\s*auto(?:\s+#.*|\s*)$/;
const TRAIL_STALE_SKEW_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 300;
const BROKER_PING_TIMEOUT_MS = 150;
const VERSION_CACHE_TTL_MS = 60_000;
const VERSION_CMD_TIMEOUT_MS = 1_500;
const DEFAULT_SIDECAR_PORT = 9100;
const MEMORY_SCORING_STORE_KEY = "memory-scoring";

export const PIDASH_API_ROUTES: ReadonlySet<string> = new Set([
  "/api/peers",
  "/api/worktrees",
  "/api/tasks",
  "/api/agents",
  "/api/crons",
  "/api/lsp",
  "/api/settings",
  "/api/memory",
  "/api/review",
  "/api/trail",
  "/api/skills",
  "/api/daemons",
  "/api/security",
  "/api/version",
  "/api/status",
  "/api/podman-build-status",
]);

export interface PidashApiDeps {
  getPort: () => number;
  getPiClients: () => Map<string, PiClient>;
  getBrowserCount: () => number;
  getAsyncAgents: () => Iterable<ActiveAsyncAgentInfo>;
  getSyncAgents?: () => Iterable<ActiveAsyncAgentInfo>;
  getStartupError?: () => string | null;
  defaultCwd?: string;
  comsDir?: string;
  brokerRunDir?: string;
  homeDir?: string;
  packageRoot?: string;
  sidecarPort?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  probeLocalHttp?: (port: number, urlPath: string, timeoutMs: number) => Promise<{ ok: boolean; status: number; body: any } | null>;
  pingLspBroker?: (socketPath: string, timeoutMs: number) => Promise<any | null>;
  execVersionCmd?: (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>;
  readPodmanBuildStatus?: () => unknown;
}

// ── Shared helpers ──────────────────────────────────────────────────

function resolveMainRootReadOnly(cwd: string): string {
  return tryResolveMainCheckoutRoot(cwd) ?? path.resolve(cwd);
}

function tryRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const trimmed = host.trim();
  if (!trimmed) return false;
  return LOOPBACK_HOST_RE.test(trimmed);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function applyLoopbackCorsHeaders(req: IncomingMessage, res: ServerResponse, port: number): void {
  const origin = req.headers.origin || "";
  const allowedOrigin = LOOPBACK_ORIGIN_RE.test(origin) ? origin : `http://127.0.0.1:${port}`;
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store");
}

function resolveRequestedCwd(
  url: URL,
  deps: PidashApiDeps,
): { ok: true; cwd: string } | { ok: false; error: string } {
  if (url.searchParams.has("cwd")) {
    const raw = url.searchParams.get("cwd") ?? "";
    if (!raw.trim() || raw.includes("\0")) {
      return { ok: false, error: "Invalid cwd: must be a non-empty existing absolute directory path" };
    }
    if (!path.isAbsolute(raw)) {
      return { ok: false, error: "Invalid cwd: must be an absolute path" };
    }
    try {
      const st = fs.statSync(raw);
      if (!st.isDirectory()) {
        return { ok: false, error: "Invalid cwd: path is not a directory" };
      }
      return { ok: true, cwd: path.resolve(raw) };
    } catch {
      return { ok: false, error: "Invalid cwd: directory does not exist" };
    }
  }

  for (const client of deps.getPiClients().values()) {
    const candidate = client?.session?.active ? client.session.cwd : "";
    if (candidate && path.isAbsolute(candidate)) {
      try {
        if (fs.statSync(candidate).isDirectory()) return { ok: true, cwd: path.resolve(candidate) };
      } catch {
        /* try next */
      }
    }
  }
  const fallback = deps.defaultCwd ?? process.cwd();
  return { ok: true, cwd: path.resolve(fallback) };
}

function defaultProbeLocalHttp(
  port: number,
  urlPath: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: any } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: { ok: boolean; status: number; body: any } | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, timeout: timeoutMs },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (raw.length < 32_768) raw += chunk;
        });
        res.on("end", () => {
          let body: any = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = null;
          }
          const status = res.statusCode ?? 0;
          finish({ ok: status >= 200 && status < 300, status, body });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
  });
}

function defaultExecVersionCmd(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const line = String(stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
      resolve(line || null);
    });
  });
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readRegularSmallTextFile(filePath: string, maxBytes = 128): string | null {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Open an existing SQLite DB strictly read-only, run `fn`, and always close the handle. */
function withReadOnlySqlite<T>(dbPath: string, fn: (db: DatabaseSync) => T): T | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function isMissingSqliteTableError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return /no such table/i.test(msg);
}

// ── Domain collectors ───────────────────────────────────────────────

export function collectPeers(deps: PidashApiDeps, projectParam: string | null, cwd?: string) {
  const now = (deps.now ?? Date.now)();
  const comsDir = deps.comsDir ?? resolveComsDir(cwd);
  const reg = new ComsRegistry(comsDir);
  const allRows = reg.readRows();
  const supervisionRecords = reg.readSupervisionRecords();

  const normalizedProject = projectParam && projectParam !== "*" ? projectParam.trim() : null;

  const piClients = deps.getPiClients();
  const findClientParentSessionId = (
    row: { project: string; name: string; pid: number | null },
    container: string | null,
  ): string | null => {
    for (const client of piClients.values()) {
      const s = client?.session;
      if (!s || !s.active) continue;
      if (s.comsProject !== row.project || s.comsName !== row.name) continue;
      const parentId = typeof s.parentSessionId === "string" ? s.parentSessionId.trim() : "";
      if (!parentId) continue;
      // Match reliable live process/container identity so a retained disconnected client
      // or a stale predecessor can never attribute an old parent to a replacement peer.
      if (container) {
        if (s.containerName === container) return parentId;
      } else if (typeof row.pid === "number" && Number.isInteger(row.pid) && row.pid > 0 && s.pid === row.pid) {
        return parentId;
      }
    }
    return null;
  };

  const peers = allRows
    .filter((row) => isRegistryRowAlive(row, now))
    .filter((row) => !normalizedProject || row.project === normalizedProject)
    .map((row) => {
      const sup = pickSupervisionRecord(supervisionRecords, row);
      const container =
        row.container ??
        (typeof sup?.container === "string" && sup.container.trim() ? sup.container.trim() : null);
      const hostPid =
        container && sup?.container === container && Number.isInteger(sup?.childPid) && (sup.childPid as number) > 0
          ? (sup.childPid as number)
          : (row.hostPid ?? null);
      const parentSessionId =
        (typeof sup?.parentSessionId === "string" && sup.parentSessionId.trim() ? sup.parentSessionId.trim() : null)
        ?? findClientParentSessionId(row, container);

      return {
        name: row.name,
        project: row.project,
        busy: Boolean(row.busy),
        contextUsedPct: typeof row.contextUsedPct === "number" ? row.contextUsedPct : null,
        queueDepth: typeof row.queueDepth === "number" ? row.queueDepth : null,
        workload: row.workload ?? null,
        cwd: row.cwd,
        model: row.model ?? null,
        purpose: row.purpose,
        pid: hostPid ?? row.pid ?? null,
        hostPid,
        container,
        ...(parentSessionId ? { parentSessionId } : {}),
        alive: true,
        startedAt: row.startedAt ?? (typeof sup?.startedAt === "string" ? sup.startedAt : null),
        heartbeatAt: row.heartbeatAt ?? null,
      };
    });

  const busy = peers.filter((p) => p.busy).length;
  return {
    project: normalizedProject ?? "*",
    total: peers.length,
    busy,
    idle: peers.length - busy,
    peers,
  };
}

function countGhostWorktreeDirs(worktrees: readonly WorktreeEntry[]): number {
  const mainWt = worktrees.find((w) => w.isMain) ?? worktrees[0];
  if (!mainWt) return 0;
  const worktreesDir = path.join(mainWt.path, ".worktrees");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const registered = new Set(worktrees.map((w) => tryRealPath(w.path)));
  let ghosts = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = tryRealPath(path.join(worktreesDir, entry.name));
    if (!registered.has(candidate)) ghosts++;
  }
  return ghosts;
}

export async function collectWorktrees(deps: PidashApiDeps, cwd: string) {
  if (!isGitRepo(cwd)) {
    return {
      cwd,
      isGitRepo: false,
      count: 0,
      ghostDirCount: 0,
      worktrees: [],
    };
  }

  const checked = await listWorktreesCheckedAsync(cwd, { includeDirty: true, forceRefresh: true });
  const entries = checked.entries;
  const livePeers = collectPeers(deps, "*", cwd).peers;

  const peersByWorktree = new Map<string, string[]>();
  for (const peer of livePeers) {
    if (!peer.cwd) continue;
    const matched = matchPathToWorktrees(peer.cwd, entries);
    if (!matched) continue;
    const list = peersByWorktree.get(matched.path) ?? [];
    list.push(peer.name);
    peersByWorktree.set(matched.path, list);
  }

  const ghostDirCount = countGhostWorktreeDirs(entries);
  const worktrees = entries.map((wt) => {
    const activeComsPeers = (peersByWorktree.get(wt.path) ?? []).sort((a, b) => a.localeCompare(b));
    const changedFiles = wt.dirty?.total ?? 0;
    return {
      name: path.basename(wt.path),
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      dirty: wt.dirty !== null ? changedFiles > 0 : false,
      changedFiles,
      isMain: wt.isMain,
      activeComsPeers,
      ghostDirCount: wt.isMain ? ghostDirCount : 0,
    };
  });

  return {
    cwd,
    isGitRepo: true,
    count: worktrees.length,
    ghostDirCount,
    worktrees,
  };
}

export function collectTasks(
  cwd: string,
  sessionParam: string | null,
  assigneeParam: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; data: any } | { ok: false; error: string } {
  const assigneeFilter = (assigneeParam || "all").trim().toLowerCase();
  if (assigneeFilter !== "all" && assigneeFilter !== "user" && assigneeFilter !== "llm") {
    return { ok: false, error: "Invalid assignee: must be 'user', 'llm', or 'all'" };
  }

  const session = sessionParam ? sessionParam.trim() : null;
  if (session && (/[/\\]/.test(session) || session.includes("..") || session.includes("\0"))) {
    return { ok: false, error: "Invalid session: must not contain path separators" };
  }

  const piTasks = env.PI_TASKS;
  const taskScope: "session" | "project" = env.PI_TASK_SCOPE === "project" ? "project" : "session";

  const files: Array<{ filePath: string; sessionId: string | null }> = [];
  if (piTasks === "off") {
    // Tasks persistence explicitly disabled — return empty without scanning stale files.
  } else if (piTasks) {
    const resolved = resolveStorePath(session ?? undefined, { cwd, piTasks, taskScope });
    if (resolved && fs.existsSync(resolved)) {
      files.push({ filePath: resolved, sessionId: null });
    }
  } else if (taskScope === "project") {
    const resolved = resolveStorePath(session ?? undefined, { cwd, piTasks: undefined, taskScope: "project" });
    if (resolved && fs.existsSync(resolved)) {
      files.push({ filePath: resolved, sessionId: null });
    }
  } else if (session) {
    const resolved = resolveStorePath(session, { cwd, piTasks: undefined, taskScope: "session" });
    if (resolved && fs.existsSync(resolved)) {
      files.push({ filePath: resolved, sessionId: session });
    }
  } else {
    const tasksDir = path.join(cwd, ".pi", "tasks");
    try {
      const dirents = fs.readdirSync(tasksDir, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isFile() || !d.name.endsWith(".json")) continue;
        if (d.name === "tasks.json") {
          files.push({ filePath: path.join(tasksDir, d.name), sessionId: null });
        } else if (d.name.startsWith("tasks-")) {
          const sid = d.name.slice("tasks-".length, -".json".length);
          files.push({ filePath: path.join(tasksDir, d.name), sessionId: sid || null });
        }
      }
    } catch {
      /* no .pi/tasks dir */
    }
  }

  const tasks: Array<{
    id: string;
    subject: string;
    status: string;
    assignee: "user" | "llm";
    blockedBy: string[];
    sessionId: string | null;
  }> = [];

  for (const { filePath, sessionId } of files) {
    try {
      const store = new TaskStore(filePath, { watch: false });
      for (const task of store.list()) {
        if ((task.status as string) === "deleted") continue;
        const taskAssignee: "user" | "llm" = task.assignee === "user" ? "user" : "llm";
        if (assigneeFilter !== "all" && taskAssignee !== assigneeFilter) continue;
        tasks.push({
          id: task.id,
          subject: task.subject,
          status: task.status,
          assignee: taskAssignee,
          blockedBy: Array.isArray(task.blockedBy) ? [...task.blockedBy] : [],
          sessionId,
        });
      }
    } catch (err: any) {
      log.warn("task_store_read_failed", { filePath, error: String(err?.message ?? err) });
    }
  }

  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let userPending = 0;
  for (const t of tasks) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "completed") completed++;
    if (t.assignee === "user" && (t.status === "pending" || t.status === "in_progress")) {
      userPending++;
    }
  }

  return {
    ok: true,
    data: {
      cwd,
      session,
      assignee: assigneeFilter,
      total: tasks.length,
      open: pending + inProgress,
      pending,
      inProgress,
      completed,
      userPending,
      tasks,
    },
  };
}

export function collectAgents(deps: PidashApiDeps, sessionParam: string | null) {
  const now = (deps.now ?? Date.now)();
  const sessionFilter = sessionParam ? sessionParam.trim() : null;
  const seen = new Set<string>();
  const agents = [];

  const sources: Array<Iterable<ActiveAsyncAgentInfo>> = [
    deps.getAsyncAgents(),
    ...(deps.getSyncAgents ? [deps.getSyncAgents()] : []),
  ];

  for (const source of sources) {
    for (const info of source) {
      if (!info?.id || seen.has(info.id)) continue;
      if (sessionFilter && info.sessionId !== sessionFilter) continue;
      seen.add(info.id);
      const startedAt = typeof info.startedAt === "number" ? info.startedAt : now;
      agents.push({
        id: info.id,
        name: info.name || info.agent,
        agent: info.agent,
        mode: info.mode === "sync" ? "sync" : "async",
        status: "running" as const,
        elapsedMs: Math.max(0, now - startedAt),
        currentTool: info.currentTool ?? null,
        cwd: info.cwd,
        taskId: info.taskId ?? null,
        sessionId: info.sessionId ?? null,
      });
    }
  }

  return {
    session: sessionFilter,
    count: agents.length,
    agents,
  };
}

export function collectCrons(cwd: string) {
  const storePath = path.join(cwd, ".pi", "cron", "crons.json");
  const outcome = readDurableCronStoreOutcome(storePath);
  const rawTasks = outcome.status === "ok" ? outcome.tasks : [];

  const crons = rawTasks.map((t) => ({
    id: t.id,
    description: t.description,
    intervalSeconds: typeof t.intervalMs === "number" ? Math.round(t.intervalMs / 1000) : null,
    atHour: typeof t.atHour === "number" ? t.atHour : null,
    atMinute: typeof t.atMinute === "number" ? t.atMinute : null,
    persist: t.scope === "project",
    paused: Boolean(t.paused),
    quietOnNoop: Boolean(t.quiet_on_noop),
    lastOutcome: t.lastOutcome ?? null,
    lastRunAt: typeof t.lastRun === "number" ? new Date(t.lastRun).toISOString() : null,
    runCount: typeof t.runCount === "number" ? t.runCount : 0,
  }));

  const paused = crons.filter((c) => c.paused).length;
  return {
    cwd,
    total: crons.length,
    active: crons.length - paused,
    paused,
    crons,
  };
}

export async function collectLsp(deps: PidashApiDeps, cwd: string) {
  const enabled = resolveTrustedLspEnabled();
  const overrides = resolveTrustedLspServers();
  const summaryData = buildLspStartupSummary({ enabled, overrides });

  const brokerRunDir = deps.brokerRunDir ?? getDefaultLspBrokerRunDir();
  const pingBroker =
    deps.pingLspBroker ??
    (async (socketPath: string, timeoutMs: number) => {
      try {
        const pong = await sendBrokerRequest(socketPath, { op: "ping" }, timeoutMs);
        return pong?.ok ? pong : null;
      } catch {
        return null;
      }
    });

  let worktreeRoots: string[] = [resolveWorktreeRoot(cwd)];
  if (isGitRepo(cwd)) {
    const checked = await listWorktreesCheckedAsync(cwd, { includeDirty: false, forceRefresh: false });
    if (checked.entries.length > 0) {
      worktreeRoots = checked.entries.map((e) => e.path);
    }
  }

  const serverIds = Array.from(new Set([...BUILTIN_LSP_SERVERS.map((s) => s.id), ...Object.keys(overrides)]));
  const probes: Array<Promise<{ worktree: string; serverId: string; alive: boolean; pid: number | null } | null>> = [];

  for (const wt of worktreeRoots) {
    for (const serverId of serverIds) {
      const socketPath = getLspBrokerSocketPath(wt, serverId, brokerRunDir);
      if (!fs.existsSync(socketPath)) continue;
      probes.push(
        pingBroker(socketPath, BROKER_PING_TIMEOUT_MS).then((pong) => ({
          worktree: wt,
          serverId,
          alive: Boolean(pong),
          pid: typeof pong?.pid === "number" ? pong.pid : null,
        })),
      );
    }
  }

  const probeResults = (await Promise.all(probes)).filter((r): r is NonNullable<typeof r> => r !== null);
  return {
    cwd,
    enabled: summaryData.enabled,
    available: summaryData.available,
    missing: summaryData.missing,
    summary: summaryData.summary,
    activeBrokers: probeResults,
  };
}

export function collectSettings(cwd: string, categoryParam: string | null, onlyOverridesParam: string | null) {
  const layers = getCachedSettingsLayers(cwd, { verifyFresh: true }) as {
    global: Record<string, unknown>;
    project: Record<string, unknown>;
  };

  const categoryFilter = categoryParam ? categoryParam.trim().toLowerCase() : null;
  const onlyOverrides = onlyOverridesParam === "true" || onlyOverridesParam === "1";

  const settings: SettingBreakdown[] = [];
  for (const key of Object.keys(SETTINGS_KEYS)) {
    const breakdown = buildSettingBreakdown(cwd, key, layers);
    if (!breakdown) continue;
    if (categoryFilter && breakdown.category.toLowerCase() !== categoryFilter) continue;
    if (onlyOverrides && breakdown.set_in.length === 0) continue;
    settings.push(breakdown);
  }

  return {
    cwd,
    category: categoryFilter,
    onlyOverrides,
    count: settings.length,
    settings,
  };
}

function readMemoryTopicsReadOnly(mainRoot: string): Array<{ name: string; entries: number; tokens: number; hotness: number }> {
  const topicsDir = path.join(mainRoot, ".pi", "memory", "topics");
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(topicsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Strictly read-only score lookup against canonical `memory-scoring` store key
  // (never triggers legacy FNV->SHA migration or DB creation).
  let scoreEntries: Record<string, { score?: number }> = {};
  const dbPath = path.join(mainRoot, ".pi", "data", "state.db");
  try {
    const rawScores = withReadOnlySqlite(dbPath, (db) => {
      try {
        const row = db
          .prepare("SELECT payload FROM kv_state WHERE store_key = ?")
          .get(MEMORY_SCORING_STORE_KEY) as { payload?: string } | undefined;
        return row?.payload ? JSON.parse(row.payload) : null;
      } catch (err) {
        if (isMissingSqliteTableError(err)) return null;
        throw err;
      }
    });
    if (rawScores?.entries && typeof rawScores.entries === "object") {
      scoreEntries = rawScores.entries as Record<string, { score?: number }>;
    }
  } catch (err: any) {
    log.warn("memory_scores_read_failed", { dbPath, error: String(err?.message ?? err) });
  }

  const topics: Array<{ name: string; entries: number; tokens: number; hotness: number }> = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".md")) continue;
    const name = d.name.slice(0, -".md".length);
    try {
      const content = fs.readFileSync(path.join(topicsDir, d.name), "utf8");
      const lines = content.split(/\r?\n/);
      let entries = 0;
      let hotnessSum = 0;
      for (const line of lines) {
        const parsed = parseTopicLine(line);
        if (parsed) {
          entries++;
          const hash = entryHash(canonicalTopicLine(parsed));
          const scored = scoreEntries[hash];
          if (scored && typeof scored.score === "number" && Number.isFinite(scored.score)) {
            hotnessSum += scored.score;
          }
        } else if (/^\s*-\s+\S/.test(line)) {
          entries++;
        }
      }
      const tokens = Math.ceil(content.length / 4);
      const hotness = Number(hotnessSum.toFixed(3));
      topics.push({ name, entries, tokens, hotness });
    } catch (err: any) {
      log.warn("memory_topic_read_failed", { file: d.name, error: String(err?.message ?? err) });
    }
  }

  return topics.sort((a, b) => b.hotness - a.hotness || a.name.localeCompare(b.name));
}

export function collectMemory(cwd: string) {
  const mainRoot = resolveMainRootReadOnly(cwd);
  const memoryDir = path.join(mainRoot, ".pi", "memory");
  const memoryExists = fs.existsSync(memoryDir);

  const topics = memoryExists ? readMemoryTopicsReadOnly(mainRoot) : [];
  const totalEntries = topics.reduce((sum, t) => sum + t.entries, 0);
  const totalTokens = topics.reduce((sum, t) => sum + t.tokens, 0);
  const tokenBudget = getMemoryTokenBudget(cwd);
  const tokenBudgetPct = tokenBudget > 0 ? Math.round((totalTokens / tokenBudget) * 100) : 0;

  const watermarkPath = path.join(memoryDir, ".dream-watermark");
  const lastDreamAt = memoryExists ? readRegularSmallTextFile(watermarkPath, 128) : null;

  const promotionsPath = path.join(memoryDir, "promotions.md");
  let pendingPromotionsCount = 0;
  if (memoryExists && fs.existsSync(promotionsPath)) {
    try {
      const content = fs.readFileSync(promotionsPath, "utf8");
      pendingPromotionsCount = parsePromotionsMarkdown(content).filter((c) => c.status === "proposed").length;
    } catch (err: any) {
      log.warn("memory_promotions_read_failed", { promotionsPath, error: String(err?.message ?? err) });
    }
  }

  return {
    cwd,
    topicCount: topics.length,
    totalEntries,
    totalTokens,
    tokenBudget,
    tokenBudgetPct,
    lastDreamAt,
    autoDream: {
      enabled: Boolean(getSetting(cwd, "dream_auto_enable")),
      intervalHours: Number(getSetting(cwd, "dream_interval_hours")),
    },
    pendingPromotionsCount,
    topics,
  };
}

function normalizeReviewStatus(raw: ReviewState["status"]): "clean" | "findings" | "needed" | "in_progress" | "none" {
  switch (raw) {
    case "clean": return "clean";
    case "has_findings": return "findings";
    case "needs_review": return "needed";
    case "in_progress": return "in_progress";
    default: return "none";
  }
}

function normalizeReviewSubjectReadOnly(raw: any): ReviewSubject | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (v: any) => (typeof v === "string" && v ? v : null);
  switch (raw.kind) {
    case "pr": {
      const repo = str(raw.repo);
      const head_sha = str(raw.head_sha);
      const number = Number(raw.number);
      return repo && head_sha && Number.isInteger(number) && number > 0
        ? { kind: "pr", repo, number, head_sha }
        : null;
    }
    case "issue": {
      const repo = str(raw.repo);
      const number = Number(raw.number);
      return repo && Number.isInteger(number) && number > 0 ? { kind: "issue", repo, number } : null;
    }
    case "local": {
      const head_sha = str(raw.head_sha);
      return head_sha ? { kind: "local", head_sha } : null;
    }
    case "plan": {
      const p = str(raw.path);
      return p ? { kind: "plan", path: p } : null;
    }
    case "other": {
      const id = str(raw.id);
      return id ? { kind: "other", id } : null;
    }
    default:
      return null;
  }
}

function parseLastValidJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  // Support pretty-printed single JSON objects (matching state-jsonl.ts canonical reader)
  try {
    const whole = JSON.parse(trimmed);
    if (whole && typeof whole === "object" && !Array.isArray(whole)) {
      return whole as Record<string, unknown>;
    }
  } catch {
    /* fall through to line-by-line JSONL scan */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

type ReviewStateReadResult =
  | { ok: true; state: Partial<ReviewState> | null }
  | { ok: false; error: string };

/** Strictly read-only review-state reader — never creates dirs/DBs, migrates, or writes markers. */
function readReviewStateReadOnly(cwd: string): ReviewStateReadResult {
  const wtRoot = resolveWorktreeRoot(cwd);
  const dataDir = path.join(wtRoot, ".pi", "data");
  const dbPath = path.join(dataDir, "state.db");

  let sqliteOutcome: { kind: "found"; raw: Record<string, unknown> } | { kind: "absent" } | { kind: "error"; error: string } = {
    kind: "absent",
  };

  if (fs.existsSync(dbPath)) {
    try {
      const result = withReadOnlySqlite(dbPath, (db) => {
        try {
          const row = db
            .prepare("SELECT payload FROM kv_state WHERE store_key = ?")
            .get("pi-config-review-state") as { payload?: unknown } | undefined;
          if (!row) return { kind: "absent" as const };
          if (typeof row.payload !== "string") {
            return { kind: "error" as const, error: "review state SQLite payload is not a string" };
          }
          const parsed = JSON.parse(row.payload);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { kind: "error" as const, error: "review state SQLite payload is not a JSON object" };
          }
          return { kind: "found" as const, raw: parsed as Record<string, unknown> };
        } catch (err: any) {
          if (isMissingSqliteTableError(err)) return { kind: "absent" as const };
          return { kind: "error" as const, error: String(err?.message ?? err) };
        }
      });
      if (result) sqliteOutcome = result;
    } catch (err: any) {
      sqliteOutcome = { kind: "error", error: String(err?.message ?? err) };
    }
  }

  if (sqliteOutcome.kind === "error") {
    // Authoritative DB row/file is corrupt or unreadable — NEVER silently fall back to stale legacy files.
    log.warn("review_state_sqlite_read_failed", { dbPath, error: sqliteOutcome.error });
    return { ok: false, error: sqliteOutcome.error };
  }

  let raw: Record<string, unknown> | null = sqliteOutcome.kind === "found" ? sqliteOutcome.raw : null;

  if (!raw) {
    const jsonlPath = path.join(dataDir, "pi-config-review-state.jsonl");
    if (fs.existsSync(jsonlPath)) {
      try {
        raw = parseLastValidJsonObject(fs.readFileSync(jsonlPath, "utf8"));
      } catch (err: any) {
        log.warn("review_state_jsonl_read_failed", { jsonlPath, error: String(err?.message ?? err) });
      }
    }
  }

  if (!raw) {
    const legacyJsonPath = path.join(dataDir, "pi-config-review-state.json");
    if (fs.existsSync(legacyJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyJsonPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        }
      } catch (err: any) {
        log.warn("review_state_json_read_failed", { legacyJsonPath, error: String(err?.message ?? err) });
      }
    }
  }

  if (!raw) return { ok: true, state: null };

  const validStatuses = new Set<ReviewState["status"]>(["none", "needs_review", "in_progress", "has_findings", "clean"]);
  const status: ReviewState["status"] = validStatuses.has(raw.status as ReviewState["status"])
    ? (raw.status as ReviewState["status"])
    : "none";
  return {
    ok: true,
    state: {
      status,
      cycle: Number.isInteger(raw.cycle) && (raw.cycle as number) >= 0 ? (raw.cycle as number) : 0,
      subject: normalizeReviewSubjectReadOnly(raw.subject),
      findings_count:
        Number.isInteger(raw.findings_count) && (raw.findings_count as number) >= 0 ? (raw.findings_count as number) : 0,
      reviewers_pending: Array.isArray(raw.reviewers_pending)
        ? raw.reviewers_pending.filter((r: unknown): r is string => typeof r === "string")
        : [],
      tests_passed: raw.tests_passed === true,
      last_clean_at: typeof raw.last_clean_at === "string" ? raw.last_clean_at : null,
    },
  };
}

export function collectReview(cwd: string) {
  const enabled = Boolean(getSetting(cwd, "review_loop_enforcement"));
  const readResult = readReviewStateReadOnly(cwd);
  if (!readResult.ok) {
    return {
      cwd,
      enabled,
      status: "unavailable" as const,
      rawStatus: "unavailable" as const,
      error: readResult.error,
      lastReviewedSha: null,
      cycle: 0,
      findingsCount: 0,
      reviewersPending: [] as string[],
      testsPassed: false,
      lastCleanAt: null,
    };
  }
  const state = readResult.state;
  const rawStatus: ReviewState["status"] = state?.status ?? "none";
  const lastReviewedSha =
    state?.subject && "head_sha" in state.subject && typeof state.subject.head_sha === "string"
      ? state.subject.head_sha
      : null;

  return {
    cwd,
    enabled,
    status: normalizeReviewStatus(rawStatus),
    rawStatus,
    lastReviewedSha,
    cycle: state?.cycle ?? 0,
    findingsCount: state?.findings_count ?? 0,
    reviewersPending: state?.reviewers_pending ? [...state.reviewers_pending] : [],
    testsPassed: state?.tests_passed ?? false,
    lastCleanAt: state?.last_clean_at ?? null,
  };
}

function isTrailEnabledReadOnly(cwd: string): boolean {
  const main = tryResolveMainCheckoutRoot(cwd);
  if (main && path.resolve(main) !== path.resolve(cwd)) {
    const own = findSettingsFile(path.join(cwd, ".pi"));
    const value = own ? parseSettingsFile(own).trail_enable : undefined;
    if (typeof value === "boolean") return value;
    return Boolean(getSetting(main, "trail_enable"));
  }
  return Boolean(getSetting(cwd, "trail_enable"));
}

function findTrailWiringFile(root: string): string | null {
  const modern = path.join(root, ".trail", "cache", ".graph", "wiring.json");
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(root, "graft", ".graph", "wiring.json");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function resolveGitIndexMtimeMs(root: string): number | null {
  const dotGit = path.join(root, ".git");
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) {
      const idx = path.join(dotGit, "index");
      return fs.existsSync(idx) ? fs.statSync(idx).mtimeMs : null;
    }
    if (st.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(content);
      if (match) {
        const gitDir = path.resolve(root, match[1].trim());
        const idx = path.join(gitDir, "index");
        return fs.existsSync(idx) ? fs.statSync(idx).mtimeMs : null;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readTrailSessionTokenSavings(root: string, sessionParam: string | null): number {
  const tmpDir = path.join(root, ".pi", "tmp");
  if (!fs.existsSync(tmpDir)) return 0;

  const readFileSavings = (file: string): number => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const val = parsed?.tokenSavings;
      return Number.isSafeInteger(val) && val >= 0 ? val : 0;
    } catch {
      return 0;
    }
  };

  if (sessionParam && sessionParam.trim()) {
    const hash = createHash("sha256").update(sessionParam.trim()).digest("hex");
    return readFileSavings(path.join(tmpDir, `trail-savings-${hash}.json`));
  }

  let total = 0;
  try {
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("trail-savings-") || !entry.name.endsWith(".json")) continue;
      total += readFileSavings(path.join(tmpDir, entry.name));
    }
  } catch {
    /* ignore */
  }
  return total;
}

export function collectTrail(cwd: string, sessionParam: string | null = null) {
  const wtRoot = resolveWorktreeRoot(cwd);
  const enabled = isTrailEnabledReadOnly(wtRoot);
  const wiringPath = findTrailWiringFile(wtRoot);
  const sessionTokenSavings = readTrailSessionTokenSavings(wtRoot, sessionParam);

  if (!wiringPath) {
    return {
      cwd,
      enabled,
      status: "missing" as const,
      fileCount: 0,
      nodeCount: 0,
      sessionTokenSavings,
    };
  }

  try {
    const wiringStat = fs.statSync(wiringPath);
    const parsed = JSON.parse(fs.readFileSync(wiringPath, "utf8")) as {
      nodes?: Array<{ path?: string }>;
      meta?: { nodeCount?: number };
    };
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const filePaths = new Set<string>();
    for (const n of nodes) {
      if (typeof n?.path === "string" && n.path) filePaths.add(n.path);
    }
    const nodeCount = Number.isSafeInteger(parsed?.meta?.nodeCount)
      ? (parsed.meta!.nodeCount as number)
      : nodes.length;

    const indexMtimeMs = resolveGitIndexMtimeMs(wtRoot);
    const stale = indexMtimeMs !== null && indexMtimeMs - wiringStat.mtimeMs > TRAIL_STALE_SKEW_MS;

    return {
      cwd,
      enabled,
      status: stale ? ("stale" as const) : ("indexed" as const),
      fileCount: filePaths.size,
      nodeCount,
      sessionTokenSavings,
    };
  } catch (err: any) {
    log.warn("trail_wiring_read_failed", { wiringPath, error: String(err?.message ?? err) });
    return {
      cwd,
      enabled,
      status: "missing" as const,
      fileCount: 0,
      nodeCount: 0,
      sessionTokenSavings,
    };
  }
}

function isSkillContentAdopted(content: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return match !== null && match[1].split(/\r?\n/).some((line) => SKILL_MAINTENANCE_MARKER_RE.test(line));
}

function isPackageSkillRealPath(realFile: string, realPackageSkillsDir: string): boolean {
  const normalized = realFile.replace(/\\/g, "/");
  if (
    normalized.includes("/pi-orchestrator-config/skills/") ||
    normalized.includes("/node_modules/")
  ) {
    return true;
  }
  const rel = path.relative(realPackageSkillsDir, realFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function collectSkills(deps: PidashApiDeps, cwd: string) {
  const homeDir = deps.homeDir ?? os.homedir();
  const packageRoot = deps.packageRoot ?? defaultPackageRoot();
  const mainRoot = resolveMainRootReadOnly(cwd);
  const packageSkillsDir = path.join(packageRoot, "skills");
  const realPackageSkillsDir = tryRealPath(packageSkillsDir);

  const roots: Array<{ dir: string; scope: "project" | "user" | "package"; origin: "top-level" | "package" }> = [
    { dir: path.join(cwd, ".pi", "skills"), scope: "project", origin: "top-level" },
  ];
  if (path.resolve(mainRoot) !== path.resolve(cwd)) {
    roots.push({ dir: path.join(mainRoot, ".pi", "skills"), scope: "project", origin: "top-level" });
  }
  roots.push(
    { dir: path.join(homeDir, ".pi", "agent", "skills"), scope: "user", origin: "top-level" },
    { dir: path.join(homeDir, ".agents", "skills"), scope: "user", origin: "top-level" },
    { dir: packageSkillsDir, scope: "package", origin: "package" },
  );

  const byName = new Map<
    string,
    {
      name: string;
      scope: "project" | "user" | "package";
      origin: "top-level" | "package";
      adoptable: boolean;
      adopted: boolean;
    }
  >();

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (byName.has(entry.name)) continue;
      const skillFile = path.join(root.dir, entry.name, "SKILL.md");
      let content: string;
      try {
        if (!fs.statSync(skillFile).isFile()) continue;
        content = fs.readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const realSkillFile = tryRealPath(skillFile);
      const isPkg = root.origin === "package" || isPackageSkillRealPath(realSkillFile, realPackageSkillsDir);
      const adoptable = !isPkg;
      const adopted = adoptable && isSkillContentAdopted(content);
      byName.set(entry.name, {
        name: entry.name,
        scope: root.scope,
        origin: isPkg ? "package" : "top-level",
        adoptable,
        adopted,
      });
    }
  }

  const loaded = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const adopted = loaded.filter((s) => s.adopted).map((s) => s.name);
  const unmarkedAdoptable = loaded.filter((s) => s.adoptable && !s.adopted).map((s) => s.name);

  return {
    cwd,
    total: loaded.length,
    adoptedCount: adopted.length,
    unmarkedAdoptableCount: unmarkedAdoptable.length,
    loaded,
    adopted,
    unmarkedAdoptable,
  };
}

export async function collectDaemons(deps: PidashApiDeps, cwd: string) {
  const probe = deps.probeLocalHttp ?? defaultProbeLocalHttp;
  const env = deps.env ?? process.env;
  const pidashPort = deps.getPort();
  const startupError = deps.getStartupError?.() ?? null;
  const piClients = deps.getPiClients();

  const pidash = {
    running: true,
    healthy: !startupError,
    status: startupError ? "degraded" : "ok",
    ...(startupError ? { startupError } : {}),
    port: pidashPort,
    sessions: piClients.size,
    browsers: deps.getBrowserCount(),
    uptime: process.uptime(),
  };

  const mainRoot = resolveMainRootReadOnly(cwd);
  const candidateDirs = [
    path.join(cwd, ".pi", "run"),
    path.join(cwd, ".pi", "tmp"),
    ...(path.resolve(mainRoot) !== path.resolve(cwd)
      ? [path.join(mainRoot, ".pi", "run"), path.join(mainRoot, ".pi", "tmp")]
      : []),
  ];

  let pidiffPort: number | null = null;
  let pidiffPid: number | null = null;
  for (const dir of candidateDirs) {
    const portVal = parsePositiveInt(readRegularSmallTextFile(path.join(dir, "pidiff.port"), 32));
    if (portVal !== null) {
      pidiffPort = portVal;
      pidiffPid = parsePositiveInt(readRegularSmallTextFile(path.join(dir, "pidiff.pid"), 32));
      break;
    }
  }

  const sidecarPort =
    deps.sidecarPort ??
    (parsePositiveInt(env.SIDECAR_PORT ?? null) ?? DEFAULT_SIDECAR_PORT);

  const [pidiffProbe, sidecarProbe] = await Promise.all([
    pidiffPort !== null ? probe(pidiffPort, "/api/health", HEALTH_PROBE_TIMEOUT_MS) : Promise.resolve(null),
    probe(sidecarPort, "/health", HEALTH_PROBE_TIMEOUT_MS),
  ]);

  const pidiffRunning = Boolean(pidiffProbe?.ok && pidiffProbe.body && typeof pidiffProbe.body === "object");
  const pidiffStatus = pidiffRunning && typeof pidiffProbe?.body?.status === "string"
    ? (pidiffProbe.body.status as string)
    : pidiffRunning
      ? "ok"
      : "stopped";

  const sidecarBody = sidecarProbe?.body && typeof sidecarProbe.body === "object" ? sidecarProbe.body : null;
  const sidecarRunning = Boolean(sidecarProbe && sidecarBody && typeof sidecarBody.status === "string");

  return {
    cwd,
    pidash,
    pidiff: {
      running: pidiffRunning,
      healthy: pidiffRunning && pidiffStatus === "ok",
      status: pidiffStatus,
      port: pidiffRunning ? pidiffPort : null,
      pid: pidiffRunning ? pidiffPid : null,
    },
    piSidecar: {
      running: sidecarRunning,
      healthy: sidecarRunning && sidecarBody?.status === "ok",
      status: sidecarRunning ? (sidecarBody.status as string) : "stopped",
      port: sidecarRunning ? sidecarPort : null,
    },
  };
}

/** Count HMAC-verified persistent folder and host approvals using a strictly read-only SQLite handle. */
function countApprovalsReadOnly(
  cwd: string,
  projectDbPath: string,
  homeDir: string,
): { folderApprovals: number; hostGrants: number } {
  if (!fs.existsSync(projectDbPath)) return { folderApprovals: 0, hostGrants: 0 };

  const key = readApprovalHmacKey(getApprovalHmacKeyPath(homeDir));
  const projectDbId = resolveProjectDbIdentity(projectDbPath, cwd, homeDir);
  let folderApprovals = 0;
  let hostGrants = 0;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(projectDbPath, { readOnly: true });

    try {
      const rows = db
        .prepare("SELECT scope, target_path, restricted_root, signature FROM restricted_folder_approvals")
        .all() as Array<{ scope?: string; target_path?: string; restricted_root?: string; signature?: string }>;
      if (key) {
        for (const row of rows) {
          if (
            (row.scope === "file" || row.scope === "directory") &&
            typeof row.target_path === "string" &&
            typeof row.restricted_root === "string" &&
            typeof row.signature === "string" &&
            verifyApprovalSignature(key, projectDbId, row.scope, row.target_path, row.restricted_root, row.signature)
          ) {
            folderApprovals++;
          }
        }
      }
    } catch (err: any) {
      if (!isMissingSqliteTableError(err)) {
        log.warn("restricted_folder_approvals_count_failed", { error: String(err?.message ?? err) });
      }
    }

    try {
      const rows = db
        .prepare("SELECT tool_name, hostname, signature FROM tool_host_approvals")
        .all() as Array<{ tool_name?: string; hostname?: string; signature?: string }>;
      if (key) {
        for (const row of rows) {
          if (
            typeof row.tool_name === "string" &&
            typeof row.hostname === "string" &&
            typeof row.signature === "string" &&
            isValidExactHostname(row.hostname) &&
            verifyHostApprovalSignature(key, projectDbId, row.tool_name, row.hostname, row.signature)
          ) {
            hostGrants++;
          }
        }
      }
    } catch (err: any) {
      if (!isMissingSqliteTableError(err)) {
        log.warn("tool_host_approvals_count_failed", { error: String(err?.message ?? err) });
      }
    }
  } catch (err: any) {
    log.warn("security_state_db_read_failed", { projectDbPath, error: String(err?.message ?? err) });
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }

  return { folderApprovals, hostGrants };
}

export function collectSecurity(deps: PidashApiDeps, cwd: string) {
  const homeDir = deps.homeDir ?? os.homedir();
  const mainRoot = resolveMainRootReadOnly(cwd);
  const projectDbPath = path.join(mainRoot, ".pi", "data", "state.db");

  // Read restricted_folders purely from settings layers so GET /api/security never
  // opens a writable SQLite handle for floor attestation reconciliation.
  const settingsLayers = getCachedSettingsLayers(cwd, { verifyFresh: true });
  const restrictedFolderSet = new Set<string>();
  for (const list of [settingsLayers.global.restricted_folders, settingsLayers.project.restricted_folders]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && entry.trim()) restrictedFolderSet.add(entry.trim());
    }
  }
  const { folderApprovals, hostGrants } = countApprovalsReadOnly(cwd, projectDbPath, homeDir);

  const layers = loadToolPermissionLayers(cwd);
  let toolRuleCount = 0;
  for (const layer of layers) {
    for (const val of Object.values(layer.rules)) {
      if (typeof val === "string") {
        toolRuleCount++;
      } else if (val && typeof val === "object") {
        toolRuleCount += Object.keys(val).length;
      }
    }
  }

  const rawAdvisorModel = getSetting(cwd, "advisor_model");
  const advisorModel =
    typeof rawAdvisorModel === "string" && rawAdvisorModel.trim()
      ? (sanitizeSettingValueForModel("advisor_model", rawAdvisorModel.trim()) as string)
      : null;

  return {
    cwd,
    secret_obfuscation: Boolean(getSetting(cwd, "secret_obfuscation")),
    restricted_folders: {
      count: restrictedFolderSet.size,
      persistentApprovalCount: folderApprovals,
    },
    tool_permissions: {
      ruleCount: toolRuleCount,
      hostGrantCount: hostGrants,
    },
    turn_snapshots: {
      enabled: Boolean(getSetting(cwd, "turn_snapshots")),
      depth: MAX_SNAPSHOT_STACK,
    },
    advisor: {
      enabled: Boolean(getSetting(cwd, "advisor_enabled")),
      model: advisorModel,
      intervalTurns: Number(getSetting(cwd, "advisor_interval_turns")),
    },
  };
}

export function createVersionCollector(deps: PidashApiDeps) {
  let cache: { at: number; value: { pi: string | null; mykPiTools: string | null } } | null = null;
  const packageRoot = deps.packageRoot ?? defaultPackageRoot();
  const execCmd = deps.execVersionCmd ?? defaultExecVersionCmd;

  return async function collectVersion() {
    const now = (deps.now ?? Date.now)();
    const runtimePi = getPiVersion();

    let pi = runtimePi;
    let mykPiTools: string | null = null;

    if (cache && now - cache.at < VERSION_CACHE_TTL_MS) {
      pi = pi ?? cache.value.pi;
      mykPiTools = cache.value.mykPiTools;
    } else {
      const [cliPi, cliTools] = await Promise.all([
        pi ? Promise.resolve(pi) : execCmd("pi", ["--version"], VERSION_CMD_TIMEOUT_MS),
        execCmd("myk-pi-tools", ["--version"], VERSION_CMD_TIMEOUT_MS),
      ]);
      pi = cliPi;
      mykPiTools = cliTools;
      cache = { at: now, value: { pi, mykPiTools } };
    }

    return {
      pi,
      minPiVersion: MIN_PI_VERSION,
      piOrchestratorConfig: readPackageVersion(packageRoot),
      mykPiTools,
      node: process.version,
    };
  };
}

// ── Router factory ──────────────────────────────────────────────────

export function createPidashApiRouter(deps: PidashApiDeps) {
  const collectVersion = createVersionCollector(deps);

  return function handlePidashApiRoute(url: URL, req: IncomingMessage, res: ServerResponse): boolean {
    if (!PIDASH_API_ROUTES.has(url.pathname)) return false;

    const remoteAddress = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddress)) {
      log.warn("rejected non-loopback /api request", {
        path: url.pathname,
        method: req.method,
        remoteAddress: remoteAddress ?? "unknown",
      });
      sendJson(res, 403, { error: "Forbidden: endpoint is restricted to loopback clients" });
      return true;
    }

    // DNS-rebinding defense: reject any non-loopback Host header
    const hostHeader = req.headers.host;
    if (hostHeader !== undefined && !isLoopbackHostHeader(hostHeader)) {
      log.warn("rejected non-loopback Host header on /api request", {
        path: url.pathname,
        host: hostHeader,
      });
      sendJson(res, 403, { error: "Forbidden: non-loopback Host header rejected" });
      return true;
    }

    // Cross-origin defense: reject any non-loopback Origin header
    const originHeader = req.headers.origin;
    if (typeof originHeader === "string" && originHeader.length > 0 && !LOOPBACK_ORIGIN_RE.test(originHeader)) {
      log.warn("rejected non-loopback Origin header on /api request", {
        path: url.pathname,
        origin: originHeader,
      });
      sendJson(res, 403, { error: "Forbidden: non-loopback Origin header rejected" });
      return true;
    }

    applyLoopbackCorsHeaders(req, res, deps.getPort());

    if (req.method !== "GET") {
      log.debug("rejected non-GET /api request", { path: url.pathname, method: req.method });
      sendJson(res, 405, { error: "Method Not Allowed: only GET is supported" }, { Allow: "GET" });
      return true;
    }

    const handleAsync = async () => {
      const pathname = url.pathname;
      const now = (deps.now ?? Date.now)();
      const env = deps.env ?? process.env;

      if (pathname === "/api/version") {
        sendJson(res, 200, await collectVersion());
        return;
      }

      if (pathname === "/api/podman-build-status") {
        const readStatus = deps.readPodmanBuildStatus ?? readBuildStatus;
        sendJson(res, 200, readStatus());
        return;
      }

      if (pathname === "/api/agents") {
        sendJson(res, 200, collectAgents(deps, url.searchParams.get("session")));
        return;
      }

      if (pathname === "/api/peers") {
        const cwdCheck = url.searchParams.has("cwd") ? resolveRequestedCwd(url, deps) : { ok: true as const, cwd: deps.defaultCwd ?? process.cwd() };
        if (!cwdCheck.ok) {
          sendJson(res, 400, { error: cwdCheck.error });
          return;
        }
        const summary = collectPeers(deps, url.searchParams.get("project"), cwdCheck.cwd);
        const format = url.searchParams.get("format");
        sendJson(res, 200, format === "array" ? summary.peers : summary);
        return;
      }

      const cwdResult = resolveRequestedCwd(url, deps);
      if (!cwdResult.ok) {
        sendJson(res, 400, { error: cwdResult.error });
        return;
      }
      const cwd = cwdResult.cwd;

      switch (pathname) {
        case "/api/worktrees": {
          sendJson(res, 200, await collectWorktrees(deps, cwd));
          return;
        }
        case "/api/tasks": {
          const result = collectTasks(cwd, url.searchParams.get("session"), url.searchParams.get("assignee"), env);
          if (!result.ok) {
            sendJson(res, 400, { error: result.error });
            return;
          }
          sendJson(res, 200, result.data);
          return;
        }
        case "/api/crons": {
          sendJson(res, 200, collectCrons(cwd));
          return;
        }
        case "/api/lsp": {
          sendJson(res, 200, await collectLsp(deps, cwd));
          return;
        }
        case "/api/settings": {
          sendJson(
            res,
            200,
            collectSettings(cwd, url.searchParams.get("category"), url.searchParams.get("only_overrides")),
          );
          return;
        }
        case "/api/memory": {
          sendJson(res, 200, collectMemory(cwd));
          return;
        }
        case "/api/review": {
          sendJson(res, 200, collectReview(cwd));
          return;
        }
        case "/api/trail": {
          sendJson(res, 200, collectTrail(cwd, url.searchParams.get("session")));
          return;
        }
        case "/api/skills": {
          sendJson(res, 200, collectSkills(deps, cwd));
          return;
        }
        case "/api/daemons": {
          sendJson(res, 200, await collectDaemons(deps, cwd));
          return;
        }
        case "/api/security": {
          sendJson(res, 200, collectSecurity(deps, cwd));
          return;
        }
        case "/api/status": {
          const projectParam = url.searchParams.get("project");
          const sessionParam = url.searchParams.get("session");
          const allSessions = Array.from(deps.getPiClients().values()).map((c) => c.session);
          const activeSessions = allSessions.filter((s) => s.active);

          const [worktrees, lsp, daemons, version] = await Promise.all([
            collectWorktrees(deps, cwd),
            collectLsp(deps, cwd),
            collectDaemons(deps, cwd),
            collectVersion(),
          ]);

          const peers = collectPeers(deps, projectParam, cwd);
          const tasksRes = collectTasks(cwd, sessionParam, "all", env);
          const agents = collectAgents(deps, sessionParam);
          const crons = collectCrons(cwd);
          const settingsAll = collectSettings(cwd, null, null);
          const settingsOverrides = settingsAll.settings.filter((s) => s.set_in.length > 0);
          const memory = collectMemory(cwd);
          const review = collectReview(cwd);
          const trail = collectTrail(cwd, sessionParam);
          const skills = collectSkills(deps, cwd);
          const security = collectSecurity(deps, cwd);

          sendJson(res, 200, {
            timestamp: new Date(now).toISOString(),
            cwd,
            project: peers.project,
            sessions: {
              total: allSessions.length,
              active: activeSessions.length,
              sessions: allSessions,
            },
            peers,
            worktrees,
            tasks: tasksRes.ok ? tasksRes.data : null,
            agents,
            crons,
            lsp,
            settings: {
              total: settingsAll.count,
              overridesCount: settingsOverrides.length,
              overrides: settingsOverrides,
            },
            memory,
            review,
            trail,
            skills,
            daemons,
            security,
            version,
          });
          return;
        }
      }
    };

    void handleAsync().catch((err: any) => {
      log.error("pidash_api_handler_error", {
        path: url.pathname,
        error: String(err?.message ?? err),
      });
      sendJson(res, 500, { error: "Internal Server Error" });
    });

    return true;
  };
}
