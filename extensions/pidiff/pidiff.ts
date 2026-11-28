/**
 * pidiff — diff viewer extension (per-project server mode).
 *
 * Thin adapter over `createDaemonClient` (`../shared/daemon-manager.ts`) and
 * `./lockfile.ts`. Each project gets its own server on a dynamically allocated
 * port, tracked via `.pi/run/pidiff.{port,pid,spawning}` lockfiles (with
 * read-only fallback to pre-#1020 `.pi/tmp/` copies).
 * Receives published review comments and injects them into the pi session.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  checkHealth,
  createDaemonClient,
  ensureUiBuilt,
  getGitBranch,
  registerDaemonCommand,
  spawnDaemon,
} from "../shared/daemon-manager.js";
import { createLogger } from "../shared/logger.js";
import { markHumanRelayedPrompt, resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { getProjectLegacyRunDir, getProjectRunDir } from "../orchestrator/utils.js";
import {
  acquireSpawnLocks,
  evaluateSpawnLock,
  findRunningPidiffPort,
  readLockfile,
  releaseSpawnLocks,
  resolveSpawnPort,
  stopPidiffDaemon,
  writeLockfile,
} from "./lockfile.js";

/** Re-exports for callers/tests that import directly from pidiff. */
export { evaluateSpawnLock, findRunningPidiffPort } from "./lockfile.js";

const ICON_DIFF = "";

const log = createLogger("pidiff");
const debugLog = (msg: string) => log.debug(msg);

function isGitRepo(cwd: string): boolean {
  try { execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" }); return true; } catch { return false; }
}

/** Resolve host for PiDiff daemon HTTP health checks and WebSocket connections (#1512). */
export function resolvePidiffHost(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.PI_PIDIFF_HOST || "").trim();
  return configured || "127.0.0.1";
}

/** Resolve optional explicit PiDiff port override (used when connecting to an authenticated host daemon). */
export function resolvePidiffPortOverride(env: Record<string, string | undefined> = process.env): number | null {
  const raw = Number.parseInt((env.PI_PIDIFF_PORT || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : null;
}

/**
 * Format a pidiff `publish-review` payload into a compact follow-up message.
 *
 * Hoists `branch` and `worktreePath` once to the top-level object whenever all
 * comments share the same value, omits redundant `source`/`type` metadata
 * already stated by the heading, and serializes compactly (no pretty-printing)
 * to save LLM input tokens.
 */
export function formatReviewMessage(parsed: { comments: any[]; summary?: string }): string {
  const comments = parsed.comments;
  const firstBranch = comments[0]?.branch;
  const sharedBranch = firstBranch && comments.every((c: any) => c.branch === firstBranch) ? firstBranch : undefined;
  const firstWorktree = comments[0]?.worktreePath;
  const sharedWorktreePath = firstWorktree && comments.every((c: any) => c.worktreePath === firstWorktree) ? firstWorktree : undefined;

  const review: Record<string, unknown> = {
    ...(sharedBranch ? { branch: sharedBranch } : {}),
    ...(sharedWorktreePath ? { worktreePath: sharedWorktreePath } : {}),
    comments: comments.map((c: any) => ({
      file: c.file,
      line: c.line,
      side: c.side,
      body: c.body,
      ...(!sharedBranch && c.branch ? { branch: c.branch } : {}),
      ...(!sharedWorktreePath && c.worktreePath ? { worktreePath: c.worktreePath } : {}),
      ...(c.replies?.length ? { replies: c.replies } : {}),
      ...(c.resolved ? { resolved: true } : {}),
    })),
    ...(parsed.summary ? { summary: parsed.summary } : {}),
  };
  return `## pidiff: Code Review Comments\n\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\`\n\nPlease address these review comments.`;
}

export function registerPidiff(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  if (shouldSkipOneshotRegister(log)) return;

  const projectCwd = process.cwd();
  const pidiffDisabled = !getSetting(projectCwd, "pidiff_enable");
  if (pidiffDisabled) {
    registerDaemonCommand(pi, "pidiff", false, "pidiff_enable");
    return;
  }

  let lockDir = ""; // Set on session_start from ctx.cwd — write target (.pi/run)
  let legacyLockDir = ""; // Pre-#1020 read-only fallback (.pi/tmp)
  let activePort = 0;

  function setStatus(ctx: any): void {
    try {
      if (ctx?.hasUI && activePort) {
        const link = hyperlink("pi-diff", `http://localhost:${activePort}`);
        const label = ICON_DIFF ? `${ICON_DIFF} ${link}` : link;
        ctx.ui.setStatus("8-diff", ctx.ui.theme.fg("accent", label));
      }
    } catch {
      // ctx may be stale if session was replaced during WebSocket connect
    }
    if (activePort) pi.events?.emit("diff-viewer:port", activePort);
  }

  function doSpawn(port: number, cwd: string): void {
    ensureUiBuilt(import.meta.url, "pidiff-ui", debugLog);
    // Keep ordinary host pidiff daemons strictly bound to loopback 127.0.0.1.
    spawnDaemon({
      serverScript: "pidiff-server.ts",
      logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidiff-server.log"),
      env: { PI_PIDIFF_PORT: String(port), PI_PIDIFF_CWD: cwd },
      log: debugLog,
    });
  }

  const pidiffHost = resolvePidiffHost(process.env);
  const pidiffPortOverride = resolvePidiffPortOverride(process.env);
  const probePidiffHealth = (port: number) => checkHealth(port, pidiffHost);

  const client = createDaemonClient(pi, {
    name: "pidiff",
    settingKey: "pidiff_enable",
    statusKey: "8-diff",
    host: pidiffHost,
    log,
    shouldAutoSpawn: () => {
      const normalized = pidiffHost.trim().toLowerCase();
      return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
    },

    canConnect() {
      return Boolean(lockDir || pidiffPortOverride);
    },

    findRunningPort() {
      const preferred = activePort || pidiffPortOverride || readLockfile(lockDir, legacyLockDir)?.port || 0;
      return findRunningPidiffPort(lockDir, legacyLockDir, preferred, probePidiffHealth);
    },

    getStatusPort() {
      return activePort || pidiffPortOverride || readLockfile(lockDir, legacyLockDir)?.port || null;
    },

    async acquireSpawnLock(ctx) {
      // Atomic spawn guard across legacy `.pi/tmp` + `.pi/run` (#1020).
      const { held, contended } = acquireSpawnLocks([legacyLockDir, lockDir]);
      if (contended === null) {
        return { acquired: true, release: () => releaseSpawnLocks(held) };
      }

      const lockDecision = evaluateSpawnLock(contended, getSetting(ctx.cwd, "pidiff_stale_lock_timeout_ms"));
      if (lockDecision.action === "recover" || lockDecision.action === "recover_pid_reuse") {
        log.info("stale_spawn_lock", lockDecision.reason);
        try { fs.unlinkSync(contended); } catch {}
        return { acquired: false, port: null, retryAfterMs: 500 };
      }

      log.debug("another session is spawning pidiff, waiting for lockfile...");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!isLiveExtensionCtx(ctx)) return { acquired: false, port: null };
        const lock = readLockfile(lockDir, legacyLockDir);
        if (lock && await probePidiffHealth(lock.port)) {
          return { acquired: false, port: lock.port };
        }
      }

      // Retry quickly (1s) if the sibling spawner is still warming up instead of
      // waiting for the 15s reconnect poller.
      return { acquired: false, port: null, retryAfterMs: 1000 };
    },

    async spawn(ctx, { mode, preferredPort }) {
      const preferred = mode === "restart"
        ? (preferredPort || null)
        : (activePort || readLockfile(lockDir, legacyLockDir)?.port || null);
      const port = await resolveSpawnPort(preferred);
      doSpawn(port, ctx.cwd);
      writeLockfile(lockDir, port, null, debugLog);
      return port;
    },

    onPortResolved(port) {
      activePort = port;
    },

    getStartupTimeoutSeconds() {
      return getSetting(process.cwd(), "pidiff_daemon_startup_timeout_s");
    },

    onOpen(wsClient, ctx, port) {
      activePort = port;
      setStatus(ctx);
      wsClient.send(JSON.stringify({
        type: "register",
        pid: process.pid,
        sessionId: `${process.pid}:${ctx.cwd}`,
        cwd: ctx.cwd,
        branch: getGitBranch(ctx.cwd),
      }));
    },

    onMessage(data) {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "publish-review" && parsed.comments?.length > 0) {
        log.debug(`review received: ${parsed.comments.length} comments`);
        const reviewMessage = formatReviewMessage(parsed);
        markHumanRelayedPrompt(reviewMessage, resolveBridgeSessionKey(client.lastCtx));
        pi.sendUserMessage(reviewMessage, { deliverAs: "followUp" });
      }
    },

    beforeCommand(_args, ctx) {
      if (isLiveExtensionCtx(ctx)) client.setLastCtx(ctx);
    },

    prepareRestart() {
      return activePort || readLockfile(lockDir, legacyLockDir)?.port || null;
    },

    stopDaemon() {
      stopPidiffDaemon(lockDir, legacyLockDir, debugLog);
      activePort = 0;
    },
  });

  // Expose handler to pidash for browser command dispatch
  try {
    if ((globalThis as any).__pidiff_pidash_listener) {
      // #951: pi's EventBus exposes only emit/on — no removeListener. This cleanup has
      // always thrown (swallowed by the catch), so the stale listener is never removed;
      // latent bug left as-is, typed to match reality.
      try { (pi.events as { removeListener?: (channel: string, handler: (data: unknown) => void) => void }).removeListener?.("pidash:request-commands", (globalThis as any).__pidiff_pidash_listener); } catch {}
    }
    const registerWithPidash = () => pi.events.emit("pidash:register-command", { name: "pidiff", handler: client.handleCommand });
    (globalThis as any).__pidiff_pidash_listener = registerWithPidash;
    registerWithPidash();
    pi.events.on("pidash:request-commands", registerWithPidash);
  } catch {}

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    client.setLastCtx(ctx);
    lockDir = getProjectRunDir(ctx.cwd);
    legacyLockDir = getProjectLegacyRunDir(ctx.cwd);
    if (!isGitRepo(ctx.cwd)) return;
    if (!client.connected && isLiveExtensionCtx(ctx) && ctx.mode === "tui") void client.connect(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    client.setLastCtx(ctx);
    if (client.connected) setStatus(ctx);
  });
}
