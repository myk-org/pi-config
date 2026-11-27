/**
 * Pidash extension — connects to the pidash daemon to expose this session.
 *
 * On session_start:
 * 1. Check if pidash daemon is running (HTTP health check)
 * 2. If not, spawn it as a detached process
 * 3. Connect via WebSocket, register this session
 * 4. Forward all pi events to the daemon
 * 5. Receive prompts from the daemon (browser → daemon → here → pi)
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  createDaemonClient,
  ensureUiBuilt,
  getGitBranch,
  killDaemon,
  registerDaemonCommand,
  spawnDaemon as spawnDaemonGeneric,
} from "../shared/daemon-manager.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { firstLiveExtensionCtx, isLiveExtensionCtx, resolveSessionStartCtx } from "../shared/live-ctx.js";
import { markBrowserDispatch } from "../shared/ui-bridge.js";
import { createLogger } from "../shared/logger.js";
import { extractToolContentText } from "../shared/pidash-transcript-reducer.js";
import { markHumanRelayedPrompt, resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { projectTurnEndEvent } from "./event-projection.js";
import { pidashModelInfo } from "./model-info.js";
import {
  WORKTREE_DIRTY_POLL_INTERVAL_MS,
  applySetting,
  buildSettingsPayload,
  getWorktreeSummary,
  loadWorktreeDetailPayload,
  loadWorktreesPayload,
  mcpList,
  pruneWorktreesOp,
  removeWorktreesOp,
  runMcp,
  worktreeSummaryEqual,
  type WorktreeSummary,
} from "./browser-ops.js";
import {
  clearPendingUiRequests,
  dismissPendingUiRequest,
  modelInfoPayload,
  recordPendingUiRequest,
  snapshotPendingUiRequests,
  supportsImagesFor,
} from "../../scripts/pidash-session-state.ts";

const log = createLogger("pidash");
const debugLog = (msg: string) => log.debug(msg);

/**
 * Last pushed async/cron snapshots.
 *
 * The orchestrator emits these as events (browser gets them live); Discord asks
 * on demand with `async-list` / `cron-list`, so the newest snapshot is kept here
 * instead of forcing a round trip into the orchestrator.
 */
let lastAsyncStatus: Record<string, unknown> | null = null;
let lastCronStatus: Record<string, unknown> | null = null;

// Module-level ref — survives closure replacement on /reload.
// raceWithBrowser captures `pi` from the closure, but after reload
// the old `pi` is stale (assertActive throws). This ref is updated
// on each extension factory call so event listeners always use the
// current runtime.
let currentPiEvents: any = null;

// ── Helpers ──────────────────────────────────────────────────────────

function spawnDaemon(port: number): void {
  ensureUiBuilt(import.meta.url, "pidash-ui", debugLog);
  spawnDaemonGeneric({
    serverScript: "pidash-server.ts",
    logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidash-server.log"),
    env: { PI_PIDASH_PORT: String(port) },
    log: debugLog,
  });
}

const execFileAsync = promisify(execFile);

export interface GitStatus {
  branch: string;
  dirty: boolean;
  changes: number;
}

export function parseGitStatusPorcelainB(output: string): GitStatus {
  if (!output) return { branch: "", dirty: false, changes: 0 };
  const lines = output.split(/\r?\n/);
  let branch = "";
  const headerLine = lines[0] ?? "";
  if (headerLine.startsWith("## ")) {
    const header = headerLine.slice(3).trim();
    if (header === "HEAD (no branch)") {
      branch = "";
    } else if (header.startsWith("No commits yet on ")) {
      branch = header.slice("No commits yet on ".length);
    } else if (header.startsWith("Initial commit on ")) {
      branch = header.slice("Initial commit on ".length);
    } else {
      branch = header.split("...")[0].replace(/ \[.*\]$/, "");
    }
  }
  let changes = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length > 0) changes++;
  }
  return { branch, dirty: changes > 0, changes };
}

export function gitStatusEqual(a: GitStatus | null, b: GitStatus): boolean {
  return a !== null && a.branch === b.branch && a.dirty === b.dirty && a.changes === b.changes;
}

/** True only when an async git status check still belongs to the active connection and session epoch. */
export function shouldPublishPeriodicGitStatus(opts: {
  shuttingDown: boolean;
  connected: boolean;
  sameSocket: boolean;
  startEpoch: number;
  currentEpoch: number;
  lastGitStatus: GitStatus | null;
  nextGitStatus: GitStatus;
}): boolean {
  if (opts.shuttingDown || !opts.connected || !opts.sameSocket) return false;
  if (opts.startEpoch !== opts.currentEpoch) return false;
  return !gitStatusEqual(opts.lastGitStatus, opts.nextGitStatus);
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-b"], {
      cwd, encoding: "utf-8", timeout: 3000,
    });
    return parseGitStatusPorcelainB(stdout);
  } catch { return { branch: "", dirty: false, changes: 0 }; }
}

function isContainer(): boolean {
  try {
    return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
  } catch { return false; }
}

/** Replay session history to the WebSocket client for browser display. */
export function replaySessionHistory(wsClient: any, ctx: any, pushBuffered: (ev: string) => void): void {
  // Wrap the whole history in the replay markers the browser already
  // understands. Without them every entry arrived as its own frame, so a
  // large transcript cost one React render per event and the browser visibly
  // crawled through the history before reaching the bottom.
  const send = (ev: object) => { try { pushBuffered(JSON.stringify(ev)); } catch {} };
  send({ type: "replay_start" });
  try {
    const entries = ctx.sessionManager?.getEntries?.() || [];
    let historyCount = 0;
    for (const entry of entries) {
      const e = entry as any;
      if (e.type !== "message" || !e.message) continue;
      const msg = e.message;
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();

      if (msg.role === "user") {
        pushBuffered(JSON.stringify({ type: "message_start", message: msg, timestamp: ts }));
      }

      if (msg.role === "assistant" && msg.content) {
        // Send thinking blocks
        for (const part of msg.content) {
          if (part.type === "thinking" && part.thinking) {
            const thinkEv = JSON.stringify({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", delta: part.thinking, partial: { model: msg.model, usage: msg.usage } },
              timestamp: ts,
            });
            pushBuffered(thinkEv);
          }
        }

        // Send text blocks
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            const textEv = JSON.stringify({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: part.text, partial: { model: msg.model, usage: msg.usage } },
              timestamp: ts,
            });
            pushBuffered(textEv);
          }
        }

        // Send tool calls with full arguments and correlation ID
        for (const part of msg.content) {
          if (part.type === "toolCall") {
            const toolEv = JSON.stringify({
              type: "tool_execution_start",
              ...(part.id !== undefined ? { toolCallId: part.id } : {}),
              toolName: part.name,
              args: part.arguments,
              timestamp: ts,
            });
            pushBuffered(toolEv);
          }
        }

        // Send message_end
        pushBuffered(JSON.stringify({ type: "message_end", message: msg, timestamp: ts }));
      }

      // Tool results — preserve full content[0..N], toolCallId, and details
      if (msg.role === "toolResult") {
        const resultEv = JSON.stringify({
          type: "tool_execution_end",
          ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
          toolName: msg.toolName,
          result: {
            content: msg.content,
            ...(msg.details !== undefined ? { details: msg.details } : {}),
          },
          isError: msg.isError || false,
          timestamp: ts,
        });
        pushBuffered(resultEv);
      }

      // Custom messages (async agent results, etc.)
      if (msg.role === "custom" && msg.display) {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (extractToolContentText(msg.content) || JSON.stringify(msg.content))
            : JSON.stringify(msg.content || "");
        pushBuffered(JSON.stringify({
          type: "message_start",
          message: { role: "custom", display: true, content, customType: msg.customType },
          timestamp: ts,
        }));
      }

      // Catch-all: any other message role — forward as-is
      if (!["user", "assistant", "toolResult", "custom"].includes(msg.role)) {
        pushBuffered(JSON.stringify({ type: "message_start", message: msg, timestamp: ts }));
      }

      historyCount++;
    }
    if (historyCount > 0) log.debug(`loaded ${historyCount} entries from session history`);
  } catch (e: any) {
    log.debug(`session history load error: ${e.message}`);
  }

  // Close the batch: the browser applies the buffered history in ONE pass.
  send({ type: "replay_end" });
  // Signal replay is complete so the server can stop suppressing notifications
  try { wsClient.send(JSON.stringify({ type: "replay_complete" })); } catch {}
}

let diffPort: number | null = null;
let isStreaming = false;

// ── Registration ─────────────────────────────────────────────────────

export function registerPidash(
  pi: ExtensionAPI,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  if (shouldSkipOneshotRegister(log)) return;
  currentPiEvents = pi.events;

  const projectCwd = process.cwd();
  const pidashPort = getSetting(projectCwd, "pidash_port");
  const pidashDisabled = !getSetting(projectCwd, "pidash_enable");
  if (pidashDisabled) {
    registerDaemonCommand(pi, "pidash", false, "pidash_enable");
    return;
  }

  // ── Closure state ──────────────────────────────────────────────────

  let lastCmdCtx: any = null;  // Command context with switchSession — updated by /pidash handler
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  const sessionId = `${process.pid}:${process.cwd()}`;
  const pendingUiStore = { pendingUiRequests: new Map<string, string>() };
  let activitySequence = 0;
  let activity: "working" | "waiting_for_input" | "idle" = "idle";
  let activityBeforePrompt: "working" | "waiting_for_input" | "idle" | null = null;
  let connectionGeneration = 0;
  let execCtx: any = null;
  let comsIdentityName: string | undefined;
  let comsIdentityPurpose: string | undefined;
  let comsIdentityProject: string | undefined;
  let trailTokenSavings: number | undefined;
  let lastGitStatus: GitStatus | null = null;
  let lastWorktreeSummary: WorktreeSummary | null = null;
  let lastWorktreeDirtyScanAt = 0;
  let sessionEpoch = 0;
  const commandHandlerRegistry = new Map<string, (args: string, ctx: any) => Promise<void> | void>();

  function publishWorktreeSummary(summary: WorktreeSummary, expectedEpoch?: number): void {
    if (client.shuttingDown || !client.connected) return;
    if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch) return;
    if (worktreeSummaryEqual(lastWorktreeSummary, summary)) return;
    lastWorktreeSummary = summary;
    client.send({
      type: "update_info",
      worktreeCount: summary.worktreeCount,
      worktreeDirtyCount: summary.worktreeDirtyCount,
      inLinkedWorktree: summary.inLinkedWorktree,
    });
  }

  // Listen for coms identity — coms ext emits this after boot
  pi.events.on("pidash:coms-identity", (data: any) => {
    comsIdentityName = data?.name;
    comsIdentityPurpose = data?.purpose;
    comsIdentityProject = data?.project;
    log.debug("coms_identity_received", comsIdentityName);
    client.send({ type: "update_info", comsName: comsIdentityName, comsPurpose: comsIdentityPurpose, comsProject: comsIdentityProject });
  });

  pi.events.on("pidash:trail-savings", (data: any) => {
    if (!Number.isSafeInteger(data?.tokenSavings) || data.tokenSavings < 0) return;
    trailTokenSavings = data.tokenSavings;
    log.debug("trail_savings_received", { tokenSavings: trailTokenSavings });
    client.send({ type: "update_info", trailTokenSavings });
  });

  // ── Command handler bridge via pi.events ──────────────────────────
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732) — native
  // command dispatch via RemoteSession.submit() eliminates this.
  pi.events.on("pidash:register-command", (data: unknown) => {
    const d = data as { name: string; handler: (args: string, ctx: any) => Promise<void> };
    if (typeof d?.name === "string" && typeof d?.handler === "function") {
      commandHandlerRegistry.set(d.name, d.handler);
      log.debug("registered command handler", d.name);
    }
  });

  // Request existing commands (handles load order — orchestrator loaded first)
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732)
  pi.events.emit("pidash:request-commands", undefined);

  // Capture command context from orchestrator
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732)
  pi.events.on("pidash:command-ctx", (ctx: unknown) => {
    if (ctx && typeof (ctx as any)?.switchSession === "function") {
      lastCmdCtx = ctx as any;
    }
  });

  // ── Extracted inner functions ──────────────────────────────────────

  /** Handle incoming WebSocket messages from the pidash daemon (prompts, commands). */
  async function handleWsMessage(data: Buffer): Promise<void> {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "prompt" && (parsed.text || parsed.images)) {
        log.debug(`received prompt from browser: ${(parsed.text || "").slice(0, 100)}${parsed.images ? ` [+${parsed.images.length} images]` : ""}`);
        // Notify browser if prompt is queued during streaming
        if (isStreaming) client.send({ type: "prompt-queued" });
        if (typeof parsed.text === "string" && parsed.text.trim()) {
          markHumanRelayedPrompt(parsed.text, resolveBridgeSessionKey(client.lastCtx));
        }
        if (parsed.images && parsed.images.length > 0) {
          // Build content array with text + images
          const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
          if (parsed.text) {
            content.push({ type: "text", text: parsed.text });
          }
          for (const img of parsed.images) {
            content.push({ type: "image", data: img.data, mimeType: img.mimeType });
          }
          pi.sendUserMessage(content, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(parsed.text, { deliverAs: "followUp" });
        }
      }
      if (parsed.type === "extension_ui_response" && parsed.id) {
        log.debug(`received UI response from browser: ${JSON.stringify(parsed).slice(0, 100)}`);
        pi.events.emit("pidash:ui-response", parsed);
      }
      if (parsed.type === "pidash-command") {
        log.debug(`received command from browser: ${parsed.command}`);

        if (parsed.command === "list-sessions") {
          try {
            const sessions = await SessionManager.list(client.lastCtx?.cwd || process.cwd());
            log.debug(`list-sessions: found ${sessions.length}`);
            client.send({ type: "sessions-list", sessions });
          } catch (e: any) { log.debug(`list-sessions error: ${e.message}`); }
        }

        if (parsed.command === "list-models") {
          try {
            if (client.lastCtx?.modelRegistry) {
              const available = client.lastCtx.modelRegistry.getAvailable();
              const list = available.map((m: any) => ({
                id: m.id,
                name: m.name,
                provider: typeof m.provider === "string" ? m.provider : m.provider?.name || "",
                reasoning: m.reasoning === true,
              }));
              log.debug(`models found: ${list.length}`);
              client.send({ type: "models-list", models: list });
            } else {
              log.debug("list-models: no modelRegistry on ctx");
            }
          } catch (e: any) { log.debug(`list-models error: ${e.message}`); }
        }

        if (parsed.command === "set-model" && parsed.modelId) {
          try {
            const model = client.lastCtx?.modelRegistry?.getAvailable()?.find((m: any) =>
              m.id === parsed.modelId || m.name === parsed.modelId || m.id.includes(parsed.modelId) || m.name.includes(parsed.modelId));
            if (model) {
              await (pi as any).setModel(model);
              log.debug(`model set to: ${model.name}`);
              client.send({ type: "update_info", ...modelInfoPayload(model) });
            }
          } catch (e: any) { log.debug(`set-model error: ${e.message}`); }
        }

        if (parsed.command === "set-thinking" && parsed.level) {
          try {
            (pi as any).setThinkingLevel(parsed.level);
            const effectiveLevel = (pi as any).getThinkingLevel?.() ?? parsed.level;
            // Pi emits thinking_level_select for this setter; the provider
            // extension persists the validated effective level for pidash too.
            log.debug(`thinking set to: ${effectiveLevel}`);
            client.send({ type: "update_info", thinkingLevel: effectiveLevel });
          } catch (e: any) { log.debug(`set-thinking error: ${e.message}`); }
        }

        if (parsed.command === "switch-session" && parsed.sessionFile) {
          log.debug(`switch-session: ${parsed.sessionFile}`);
          const ctx = lastCmdCtx ?? client.lastCtx;
          if (ctx?.switchSession) {
            try {
              await ctx.switchSession(parsed.sessionFile, {
                withSession: async () => {
                  log.debug("switch-session: completed");
                },
              });
            } catch (e: any) {
              log.debug(`switch-session error: ${e.message}`);
            }
          } else {
            log.debug("switch-session: no command context available");
          }
        }

        if (parsed.command === "abort") {
          if (client.lastCtx) {
            try { client.lastCtx.abort(); log.debug("abort sent"); } catch {}
          }
        }

        if (parsed.command === "async-kill" && parsed.target) {
          log.debug(`async-kill from browser: ${parsed.target}`);
          pi.events.emit("pidash:async-kill", parsed.target);
        }

        if (parsed.command === "async-list") {
          const snapshot = lastAsyncStatus ?? { count: 0, jobs: [] };
          log.debug(`async-list from client: ${(snapshot as any).count ?? 0} running`);
          client.send({ type: "async-list", requestId: parsed.requestId, ...snapshot });
        }

        if (parsed.command === "cron-list") {
          const snapshot = lastCronStatus ?? { count: 0, tasks: [] };
          log.debug(`cron-list from client: ${(snapshot as any).count ?? 0} tasks`);
          client.send({ type: "cron-list", requestId: parsed.requestId, ...snapshot });
        }

        if (parsed.command === "cron-kill" && parsed.target) {
          log.debug(`cron-kill from browser: ${parsed.target}`);
          pi.events.emit("pidash:cron-kill", parsed.target);
        }

        if (parsed.command === "rename-session") {
          log.debug("rename-session full parsed", JSON.stringify(parsed));
          const newName = parsed.name ?? parsed.newName ?? "";
          if (newName !== undefined) {
            try {
              (pi as any).setSessionName?.(newName);
              sessionNamed = true;
              log.debug(`session renamed: ${newName}`);
              // Also send update_info to ensure sidebar updates immediately
              client.send({ type: "update_info", name: newName });
            } catch (e: any) { log.debug(`rename-session error: ${e.message}`); }
          }
        }

        // ── #968 part D: session lifecycle ─────────────────────────
        if (parsed.command === "compact") {
          const ctx = lastCmdCtx ?? client.lastCtx;
          try {
            if (typeof ctx?.compact === "function") {
              ctx.compact();
              log.info("compact triggered from browser");
            } else {
              // Never silently do nothing — the browser user clicked a button
              // and deserves to learn the operation is unavailable.
              log.warn("compact from browser unavailable — no compact on command context");
              client.send({ type: "error", error: "compact unavailable in this runtime" });
            }
          } catch (e: any) { log.warn(`compact error: ${e.message}`); }
        }

        if (parsed.command === "new-session") {
          const ctx = lastCmdCtx ?? client.lastCtx;
          if (ctx?.newSession) {
            try {
              // Name/model are applied on the NEW session context inside
              // withSession — the captured `pi`/`lastCtx` are stale once the
              // session is replaced (assertActive throws, errors were
              // swallowed and the new session kept default name/model).
              const result = await ctx.newSession({
                withSession: async (newCtx: any) => {
                  if (parsed.name) {
                    try { newCtx.setSessionName?.(String(parsed.name)); } catch (e: any) { log.warn(`setSessionName on new session failed: ${e.message}`); }
                  }
                  if (parsed.modelId && newCtx?.modelRegistry) {
                    const model = newCtx.modelRegistry.getAvailable()?.find((m: any) =>
                      m.id === parsed.modelId || m.name === parsed.modelId || m.id.includes(parsed.modelId) || m.name.includes(parsed.modelId));
                    if (model) {
                      try { await newCtx.setModel(model); } catch (e: any) { log.warn(`setModel on new session failed: ${e.message}`); }
                    } else {
                      log.warn(`new-session model not found: ${parsed.modelId}`);
                    }
                  }
                },
              });
              log.info("new-session created from browser", { name: parsed.name, modelId: parsed.modelId, cancelled: result?.cancelled });
            } catch (e: any) { log.warn(`new-session error: ${e.message}`); }
          } else {
            log.warn("new-session from browser unavailable — no newSession on command context");
            client.send({ type: "error", error: "new-session unavailable in this runtime" });
          }
        }

        // ── #968 parts A/C/E: route to owning extensions ────────────
        if (parsed.command === "tasks-list") {
          pi.events.emit("pidash:tasks-list-request", undefined);
        }
        if (parsed.command === "task-op") {
          pi.events.emit("pidash:task-op", parsed);
        }
        if (parsed.command === "coms-peers") {
          pi.events.emit("pidash:coms-peers-request", undefined);
        }
        if (parsed.command === "coms-send") {
          pi.events.emit("pidash:coms-send", {
            requestId: parsed.requestId,
            target: parsed.target,
            prompt: parsed.prompt,
            steer: parsed.steer === true,
            priority: parsed.priority === true,
          });
        }
        if (parsed.command === "memory-status") {
          // Pass the watched session's cwd — memory is per-project, and the
          // browser may be watching a session in a different project than
          // this process's cwd.
          pi.events.emit("pidash:memory-status-request", { cwd: client.lastCtx?.cwd || process.cwd() });
        }

        // ── #968 part F: MCP management ─────────────────────────────
        if (parsed.command === "mcp-list") {
          const cwd = client.lastCtx?.cwd || process.cwd();
          const result = await mcpList(cwd);
          client.send({ type: "mcp-list", ...result });
        }
        if (parsed.command === "mcp-login" && parsed.server) {
          const cwd = client.lastCtx?.cwd || process.cwd();
          try {
            const out = await runMcp(["login", String(parsed.server)], cwd, 180000);
            log.info("mcp-login from browser", { server: parsed.server });
            client.send({ type: "mcp-op-result", op: "login", server: parsed.server, ok: true, output: out.slice(0, 4000) });
          } catch (e: any) {
            log.warn(`mcp-login error: ${e?.message}`);
            client.send({ type: "mcp-op-result", op: "login", server: parsed.server, ok: false, output: String(e?.stderr || e?.message || e).slice(0, 4000) });
          }
        }
        if (parsed.command === "mcp-logout" && parsed.server) {
          const cwd = client.lastCtx?.cwd || process.cwd();
          try {
            const out = await runMcp(["logout", String(parsed.server)], cwd);
            log.info("mcp-logout from browser", { server: parsed.server });
            client.send({ type: "mcp-op-result", op: "logout", server: parsed.server, ok: true, output: out.slice(0, 4000) });
          } catch (e: any) {
            log.warn(`mcp-logout error: ${e?.message}`);
            client.send({ type: "mcp-op-result", op: "logout", server: parsed.server, ok: false, output: String(e?.stderr || e?.message || e).slice(0, 4000) });
          }
        }

        // ── #968 part G: settings page ──────────────────────────────
        if (parsed.command === "settings-get") {
          const cwd = client.lastCtx?.cwd || process.cwd();
          const payload = buildSettingsPayload(cwd, parsed.scope);
          client.send({ type: "settings-data", ...payload });
        }
        if (parsed.command === "settings-set" && parsed.key) {
          const cwd = client.lastCtx?.cwd || process.cwd();
          const result = applySetting(cwd, parsed.scope, String(parsed.key), "value" in parsed ? parsed.value : null);
          if (result.ok) {
            // Broadcast fresh state to EVERY connected browser — settings
            // files are shared across sessions (same project / global scope),
            // so browsers watching other sessions must not keep stale values
            // (Qodo R3). The daemon fans settings-broadcast out to all.
            const payload = buildSettingsPayload(cwd, parsed.scope);
            // sourceCwd lets browsers watching OTHER projects ignore a
            // project-scoped broadcast that isn't theirs (Qodo R4)
            client.send({ type: "settings-broadcast", payload: { type: "settings-data", sourceCwd: cwd, ...payload } });
          } else {
            client.send({ type: "settings-error", scope: parsed.scope, key: parsed.key, error: result.error });
          }
        }

        if (parsed.command === "list-commands") {
          try {
            const cmds = (pi as any).getCommands?.() || [];
            const list = cmds.map((c: any) => ({ name: c.name, description: c.description || "" }));
            client.send({ type: "commands-list", commands: list });
          } catch (e: any) { log.debug(`list-commands error: ${e.message}`); }
        }

        // ── #1427: Worktrees panel operations ──────────────────────
        if (parsed.command === "worktrees-list") {
          const startEpoch = sessionEpoch;
          const cwd = client.lastCtx?.cwd || process.cwd();
          const payload = await loadWorktreesPayload(cwd, {
            forceRefresh: parsed.forceRefresh !== false,
            forceRefreshPrs: parsed.forceRefreshPrs === true,
          });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          client.send({
            type: "worktrees-list",
            requestId: parsed.requestId,
            sourceSessionId: sessionId,
            ...payload,
          });
          if (!payload.error) {
            lastWorktreeDirtyScanAt = Date.now();
            publishWorktreeSummary(
              {
                worktreeCount: payload.linkedCount,
                worktreeDirtyCount: payload.dirtyCount,
                inLinkedWorktree: payload.inLinkedWorktree,
              },
              startEpoch,
            );
          }
        }
        if (parsed.command === "worktrees-detail") {
          const startEpoch = sessionEpoch;
          const cwd = client.lastCtx?.cwd || process.cwd();
          const detail = await loadWorktreeDetailPayload(cwd, parsed.path);
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          client.send({
            type: "worktrees-detail",
            requestId: parsed.requestId,
            ...detail,
          });
        }
        if (parsed.command === "worktrees-prune") {
          const startEpoch = sessionEpoch;
          const cwd = client.lastCtx?.cwd || process.cwd();
          const result = await pruneWorktreesOp(cwd, {
            onWorktreesChanged: () => { pi.events.emit("orchestrator:worktrees-changed", { source: "pidash" }); },
          });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          client.send({ type: "worktrees-op-result", requestId: parsed.requestId, ...result });
          const payload = await loadWorktreesPayload(cwd, { forceRefresh: true });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          if (!payload.error) {
            lastWorktreeDirtyScanAt = Date.now();
            publishWorktreeSummary(
              {
                worktreeCount: payload.linkedCount,
                worktreeDirtyCount: payload.dirtyCount,
                inLinkedWorktree: payload.inLinkedWorktree,
              },
              startEpoch,
            );
          }
          client.send({
            type: "worktrees-broadcast",
            repoRoot: payload.repoRoot,
            sourceSessionId: sessionId,
          });
        }
        if (parsed.command === "worktrees-remove") {
          const startEpoch = sessionEpoch;
          const cwd = client.lastCtx?.cwd || process.cwd();
          const targetPaths = parsed.paths !== undefined ? parsed.paths : parsed.path;
          const result = await removeWorktreesOp(cwd, targetPaths, {
            onWorktreesChanged: () => { pi.events.emit("orchestrator:worktrees-changed", { source: "pidash" }); },
          });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          client.send({ type: "worktrees-op-result", requestId: parsed.requestId, ...result });
          const payload = await loadWorktreesPayload(cwd, { forceRefresh: true });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          if (!payload.error) {
            lastWorktreeDirtyScanAt = Date.now();
            publishWorktreeSummary(
              {
                worktreeCount: payload.linkedCount,
                worktreeDirtyCount: payload.dirtyCount,
                inLinkedWorktree: payload.inLinkedWorktree,
              },
              startEpoch,
            );
          }
          client.send({
            type: "worktrees-broadcast",
            repoRoot: payload.repoRoot,
            sourceSessionId: sessionId,
          });
        }

      }
    } catch (e: any) { log.debug(`message handler error: ${e.message}`); }
  }

  // ── Shared daemon client adapter ───────────────────────────────────

  const client = createDaemonClient<{ git: GitStatus; worktrees: WorktreeSummary | null }>(pi, {
    name: "pidash",
    settingKey: "pidash_enable",
    statusKey: "9-pidash",
    log,
    port: pidashPort,
    startFailureHint: " — check ~/.pi/pidash-server.log",
    strictCommandUsage: true,

    spawn() {
      spawnDaemon(pidashPort);
      return pidashPort;
    },

    getStartupTimeoutSeconds() {
      // jiti cold compilation can take 30+ seconds on first run
      return 60;
    },

    async beforeOpen(ctx) {
      const startEpoch = sessionEpoch;
      const [git, worktrees] = await Promise.all([
        getGitStatus(ctx.cwd),
        getWorktreeSummary(ctx.cwd, { includeDirty: true }),
      ]);
      if (startEpoch !== sessionEpoch) return { abort: true };
      if (worktrees !== null) {
        lastWorktreeDirtyScanAt = Date.now();
      }
      return { data: { git, worktrees } };
    },

    onOpen(wsClient, ctx, _port, initial) {
      const thisConnectionGeneration = ++connectionGeneration;
      const resolvedGit = initial?.git ?? { branch: "", dirty: false, changes: 0 };
      const initialWorktrees = initial?.worktrees ?? null;
      lastGitStatus = resolvedGit;
      lastWorktreeSummary = initialWorktrees;
      const regWorktrees = initialWorktrees ?? { worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false };
      const m = ctx.model;
      let thinking = "medium";
      try {
        thinking = (pi as any).getThinkingLevel?.() || "medium";
      } catch (e: any) { log.debug(`getThinkingLevel failed: session=${sessionId} error=${e?.message || e}`); }
      const reg = JSON.stringify({
        type: "register",
        pid: process.pid,
        sessionId,
        connectionGeneration: thisConnectionGeneration,
        cwd: ctx.cwd,
        branch: resolvedGit.branch,
        gitDirty: resolvedGit.dirty,
        gitChanges: resolvedGit.changes,
        worktreeCount: regWorktrees.worktreeCount,
        worktreeDirtyCount: regWorktrees.worktreeDirtyCount,
        inLinkedWorktree: regWorktrees.inLinkedWorktree,
        container: isContainer(),
        model: m?.name || m?.id || "",
        reasoning: m?.reasoning === true,
        supportsImages: supportsImagesFor(m),
        contextWindow: m?.contextWindow || 0,
        startedAt: new Date().toISOString(),
        activity,
        activitySequence,
        activityBeforePrompt: activityBeforePrompt || undefined,
        streaming: isStreaming,
        sessionFile: ctx.sessionManager?.getSessionFile?.() || ctx.sessionFile || "",
        thinkingLevel: thinking,
        diffPort,
        name: (pi as any).getSessionName?.() || undefined,
        comsName: comsIdentityName || (pi as any).getFlag?.("cname") || undefined,
        comsPurpose: comsIdentityPurpose || (pi as any).getFlag?.("purpose") || undefined,
        comsProject: comsIdentityProject || undefined,
        trailTokenSavings,
      });
      log.debug(`sending register: ${reg}`);
      wsClient.send(reg);

      // Always load history from session file (source of truth)
      replaySessionHistory(wsClient, ctx, (ev: string) => {
        wsClient.send(ev);
      });

      // Re-send still-open interactive prompts after replay_complete so the daemon
      // records them as live (not replaying) and restores active browser dialogs.
      const pendingUi = snapshotPendingUiRequests(pendingUiStore);
      if (pendingUi.length > 0) {
        log.debug("resending pending UI requests after replay_complete", { count: pendingUi.length });
        for (const rawReq of pendingUi) {
          try { wsClient.send(rawReq); } catch {}
        }
      }

      if (ctx.hasUI) {
        const link = hyperlink("pi-dash", `http://localhost:${pidashPort}`);
        ctx.ui.setStatus("9-pidash", ctx.ui.theme.fg("accent", link));
      }
    },

    onMessage(data) {
      return handleWsMessage(data);
    },

    onDisconnect() {
      lastGitStatus = null;
      lastWorktreeSummary = null;
      lastWorktreeDirtyScanAt = 0;
    },

    onBeforeShutdown(event, activeWs, isConnected) {
      const cleared = clearPendingUiRequests(pendingUiStore);
      if (cleared > 0) log.debug("cleared pending UI requests on session_shutdown", { count: cleared });
      if (activeWs && isConnected) {
        try {
          activeWs.send(JSON.stringify({
            type: "session_shutdown",
            reason: (event as any)?.reason,
            targetSessionFile: (event as any)?.targetSessionFile,
          }));
        } catch {}
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    },

    beforeCommand(_args, ctx) {
      lastCmdCtx = ctx;
      // Guard: pidash daemon connections only in TUI mode
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("pidash is only available in TUI mode.", "info");
        return false;
      }
      execCtx = ctx;
    },

    stopDaemon() {
      killDaemon("pidash-server", debugLog);
    },
  });

  // ── forward() helper ──────────────────────────────────────────────

  // Forward events to daemon
  function forward(type: string) {
    pi.on(type as any, (event: any, ctx: any) => {
      if (client.shuttingDown) return;
      client.setLastCtx(ctx);
      const timestamp = Date.now();
      let payload: any = type === "turn_end"
        ? projectTurnEndEvent(event, timestamp)
        : { type, ...event, timestamp };
      log.debug("forwarding event", { type });
      if (["agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end"].includes(type)) {
        payload.activitySequence = ++activitySequence;
        if (type === "agent_start") activity = "working";
        else if (type === "ui_prompt_start") {
          activityBeforePrompt = activity;
          activity = "waiting_for_input";
        } else if (type === "ui_prompt_end") {
          activity = activityBeforePrompt ?? "working";
          activityBeforePrompt = null;
        } else if (type === "agent_end") activity = "idle";
        log.debug(`activity event forwarded: ${type} activity=${activity} sequence=${payload.activitySequence}`);
      }

      // Optimize message_update: strip the full accumulated partial message
      // to prevent events growing larger as streaming progresses.
      // Keep only delta + essential metadata (model, usage).
      if (type === "message_update" && payload.assistantMessageEvent?.partial) {
        const ae = payload.assistantMessageEvent;
        payload = {
          type,
          assistantMessageEvent: {
            type: ae.type,
            delta: ae.delta,
            contentIndex: ae.contentIndex,
            content: ae.content,
            partial: ae.partial ? {
              model: ae.partial.model,
              usage: ae.partial.usage,
              provider: ae.partial.provider,
            } : undefined,
          },
          timestamp: payload.timestamp,
        };
      }

      // Strip full message from message_end (can be large for resumed sessions)
      // Keep only role and essential content
      if (type === "message_end" && payload.message) {
        const m = payload.message;
        const isStreamed = ["user", "assistant", "toolResult"].includes(m.role);
        payload = {
          type,
          message: {
            role: m.role,
            model: m.model,
            usage: m.usage,
            provider: m.provider,
            customType: m.customType,
            display: m.display,
            ...(isStreamed ? {} : { content: m.content }),
          },
          timestamp: payload.timestamp,
        };
      }

      const msg = JSON.stringify(payload);
      if (!client.send(msg) && !client.connected) {
        log.debug(`forward ${type}: ws not connected`);
      }
    });
  }

  // ── Setup functions ────────────────────────────────────────────────

  /** Register all forward() calls and individual pi.on() handlers that forward events to the daemon. */
  function setupEventForwarding(): void {
    forward("agent_start");
    forward("agent_end");
    forward("agent_settled");
    forward("ui_prompt_start");
    forward("ui_prompt_end");

    // Track streaming state for prompt-queued feedback
    pi.on("agent_start", () => { if (client.shuttingDown) return; isStreaming = true; });
    pi.on("agent_settled", () => { if (client.shuttingDown) return; isStreaming = false; });
    forward("turn_end");
    forward("message_start");
    forward("message_update");
    forward("message_end");
    forward("tool_execution_start");
    forward("tool_execution_update");
    forward("tool_execution_end");
    forward("tool_call");
    forward("session_info_changed");

    pi.on("model_select", (event: any) => {
      if (client.shuttingDown) return;
      client.send({ type: "update_info", ...pidashModelInfo(event.model) });
    });

    // Sync thinking level on every turn
    pi.on("turn_end", () => {
      if (client.shuttingDown || !client.connected) return;
      try {
        const level = (pi as any).getThinkingLevel?.();
        if (level) client.send({ type: "update_info", thinkingLevel: level });
      } catch {}
    });

    // Track diff viewer port
    pi.events.on("diff-viewer:port", (port: unknown) => {
      if (typeof port === "number") {
        diffPort = port;
        client.send({ type: "update_info", diffPort: port });
      }
    });
  }

  /** Register pi.events.on() listeners for pidash-specific events. */
  function setupPidashEventListeners(): void {
    // Forward ask_user requests to the daemon for browser display
    pi.events.on("pidash:ui-request", (data: unknown) => {
      if (client.shuttingDown) return;
      const req = data as { id?: string; method?: string } | null;
      let serialized: string | undefined;
      try { serialized = JSON.stringify(data); } catch {}
      if (typeof serialized !== "string") return;
      const recorded = recordPendingUiRequest(pendingUiStore, data, serialized);
      if (client.connected) {
        log.debug("forwarding pidash:ui-request", { id: req?.id, method: req?.method, recorded });
        client.send(serialized);
      } else if (recorded) {
        log.debug("recorded pending pidash:ui-request while disconnected", { id: req?.id, method: req?.method });
      }
    });

    // Forward dialog dismissals to the browser
    pi.events.on("pidash:ui-dismiss", (data: unknown) => {
      if (client.shuttingDown) return;
      const req = data as { id?: string } | null;
      const dismissed = dismissPendingUiRequest(pendingUiStore, req?.id);
      if (client.connected) {
        log.debug("forwarding pidash:ui-dismiss", { id: req?.id, dismissed });
        client.send(data as object);
      } else if (dismissed) {
        log.debug("dismissed pending pidash:ui-dismiss while disconnected", { id: req?.id });
      }
    });

    // Forward async agent status to browser, and keep the last snapshot: the
    // orchestrator PUSHES these, so a client that asks later (Discord `/async`)
    // needs something to read (request/response like every other command).
    pi.events.on("pidash:async-status", (data: unknown) => {
      lastAsyncStatus = (data ?? {}) as Record<string, unknown>;
      client.send({ type: "async-status", ...(data as any) });
    });

    // Forward cron status to browser
    pi.events.on("pidash:cron-status", (data: unknown) => {
      lastCronStatus = (data ?? {}) as Record<string, unknown>;
      client.send({ type: "cron-status", ...(data as any) });
    });

    // Forward task list updates to browser (#968 A)
    pi.events.on("pidash:tasks-list", (data: unknown) => {
      client.send({ type: "tasks-list", ...(data as any) });
    });

    // Forward coms peer list / send results to browser (#968 C)
    pi.events.on("pidash:coms-peers", (data: unknown) => {
      client.send({ type: "coms-peers", ...(data as any) });
    });
    pi.events.on("pidash:coms-send-result", (data: unknown) => {
      client.send({ type: "coms-send-result", ...(data as any) });
    });

    // Forward memory status to browser (#968 E)
    pi.events.on("pidash:memory-status", (data: unknown) => {
      client.send({ type: "memory-status", ...(data as any) });
    });

    // Forward coms peer join/leave events to browser
    pi.events.on("pidash:coms-peer-event", (data: unknown) => {
      const d = data as { customType?: string; content?: string };
      if (!d?.customType) return;
      client.send({ type: "coms_peer_event", customType: d.customType, content: d.content || "" });
    });

    // Keep connected browsers in sync when TUI /worktree mutates worktrees (#1427)
    pi.events.on("orchestrator:worktrees-changed", (data: unknown) => {
      if (client.shuttingDown || !client.connected) return;
      if ((data as { source?: string } | null)?.source === "pidash") return;
      const startEpoch = sessionEpoch;
      const cwd = client.lastCtx?.cwd || process.cwd();
      void (async () => {
        try {
          const payload = await loadWorktreesPayload(cwd, { forceRefresh: true });
          if (client.shuttingDown || !client.connected || startEpoch !== sessionEpoch) return;
          if (!payload.error) {
            lastWorktreeDirtyScanAt = Date.now();
            publishWorktreeSummary(
              {
                worktreeCount: payload.linkedCount,
                worktreeDirtyCount: payload.dirtyCount,
                inLinkedWorktree: payload.inLinkedWorktree,
              },
              startEpoch,
            );
          }
          client.send({
            type: "worktrees-broadcast",
            repoRoot: payload.repoRoot,
            sourceSessionId: sessionId,
          });
        } catch (e: any) {
          log.debug("worktrees_changed_broadcast_failed", { error: e?.message || String(e) });
        }
      })();
    });

  }

  /** Periodically send git status and worktree summary updates to the daemon (async, skipped when unchanged). */
  function setupPeriodicStatus(): ReturnType<typeof setInterval> {
    let inFlight = false;
    const interval = setInterval(async () => {
      if (client.shuttingDown || !client.ws || !client.connected || !client.lastCtx || inFlight) return;
      const ctx = client.lastCtx;
      const activeWs = client.ws;
      const startEpoch = sessionEpoch;
      if (!isLiveExtensionCtx(ctx)) {
        log.debug("periodic status stopped — stale ctx after session replacement");
        client.setLastCtx(null);
        return;
      }
      if (ctx.mode !== "tui") return;
      inFlight = true;
      try {
        const now = Date.now();
        const shouldScanDirty = now - lastWorktreeDirtyScanAt >= WORKTREE_DIRTY_POLL_INTERVAL_MS;
        const [git, wtSummary] = await Promise.all([
          getGitStatus(ctx.cwd),
          getWorktreeSummary(ctx.cwd, {
            includeDirty: shouldScanDirty,
            fallbackDirtyCount: lastWorktreeSummary?.worktreeDirtyCount ?? 0,
          }),
        ]);
        const gitChanged = shouldPublishPeriodicGitStatus({
          shuttingDown: client.shuttingDown,
          connected: client.connected,
          sameSocket: client.ws === activeWs,
          startEpoch,
          currentEpoch: sessionEpoch,
          lastGitStatus,
          nextGitStatus: git,
        });
        const stillValid = !client.shuttingDown && client.connected && client.ws === activeWs && startEpoch === sessionEpoch;
        if (stillValid && shouldScanDirty && wtSummary !== null) {
          lastWorktreeDirtyScanAt = now;
        }
        const wtChanged = stillValid && wtSummary !== null && !worktreeSummaryEqual(lastWorktreeSummary, wtSummary);
        if (!gitChanged && !wtChanged) return;
        if (gitChanged) lastGitStatus = git;
        if (wtChanged && wtSummary !== null) lastWorktreeSummary = wtSummary;
        activeWs.send(JSON.stringify({
          type: "update_info",
          ...(gitChanged ? { branch: git.branch, gitDirty: git.dirty, gitChanges: git.changes } : {}),
          ...(wtChanged && wtSummary !== null ? {
            worktreeCount: wtSummary.worktreeCount,
            worktreeDirtyCount: wtSummary.worktreeDirtyCount,
            inLinkedWorktree: wtSummary.inLinkedWorktree,
          } : {}),
        }));
      } catch (e: any) { log.debug(`periodic status error: ${e?.message || e}`); }
      finally { inFlight = false; }
    }, 10000);
    if (interval.unref) interval.unref();
    return interval;
  }

  /** Handle session_start event — connect or notify session switch. */
  function handleSessionStart(event: any, ctx: any): void {
    sessionNamed = false;
    log.debug("session_start", (event as any)?.reason);
    if (["new", "fork"].includes(event?.reason)) trailTokenSavings = 0;
    if (["new", "resume", "fork"].includes(event?.reason)) {
      const cleared = clearPendingUiRequests(pendingUiStore);
      if (cleared > 0) log.debug("cleared pending UI requests on session_start", { reason: event?.reason, count: cleared });
    }

    const resolved = resolveSessionStartCtx(client.lastCtx, ctx);
    client.setLastCtx(resolved.lastCtx);
    execCtx = resolved.execCtx;
    if (execCtx) log.debug("execCtx set from session_start");
    else log.debug("session_start: execCtx cleared — no live ctx");
    if (resolved.lastCtx === ctx) log.debug("lastCtx updated from session_start");

    const switchCtx = resolved.switchCtx;
    if (!client.connected && switchCtx && switchCtx.mode === "tui") {
      void client.connect(switchCtx);
    } else if (client.ws) {
      if (!switchCtx) {
        log.debug("session_switch skipped — no live ctx");
        return;
      }
      // Already connected — session switched (e.g., /resume, /new)
      sessionEpoch++;
      const cleared = clearPendingUiRequests(pendingUiStore);
      if (cleared > 0) log.debug("cleared pending UI requests on session_switch", { count: cleared });
      activitySequence = 0;
      activity = "idle";
      activityBeforePrompt = null;
      lastGitStatus = null;
      lastWorktreeSummary = { worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false };
      lastWorktreeDirtyScanAt = 0;
      const switchEpoch = sessionEpoch;
      client.send({
        type: "session_switch",
        sessionId,
        cwd: switchCtx.cwd,
        branch: getGitBranch(switchCtx.cwd),
        worktreeCount: 0,
        worktreeDirtyCount: 0,
        inLinkedWorktree: false,
        sessionFile: switchCtx.sessionManager?.getSessionFile?.() || switchCtx.sessionFile || "",
        // One producer for every model field, so a switch cannot omit the
        // capability the daemon relies on (Qodo 3e547c6d / 24f50129).
        ...modelInfoPayload(switchCtx.model),
        thinkingLevel: (pi as any).getThinkingLevel?.() || "medium",
        trailTokenSavings,
      });
      log.debug(`session_switch sent: cwd=${switchCtx.cwd}`);
      void (async () => {
        try {
          const wtSummary = await getWorktreeSummary(switchCtx.cwd, { includeDirty: true });
          if (client.shuttingDown || !client.connected || switchEpoch !== sessionEpoch || wtSummary === null) return;
          lastWorktreeDirtyScanAt = Date.now();
          publishWorktreeSummary(wtSummary, switchEpoch);
        } catch (e: any) {
          log.debug("session_switch_worktree_summary_failed", { error: e?.message || String(e) });
        }
      })();
    }
  }

  /** Handle input event — intercept extension commands from browser. */
  async function handleBrowserInput(event: any, _ctx: any): Promise<{ action: "handled" } | void> {
    if ((event as any).streamingBehavior) {
      client.send({ type: "streaming-behavior", behavior: (event as any).streamingBehavior });
    }

    // Intercept extension commands from browser
    if (event.source !== "extension") return;
    if (!event.text.startsWith("/")) return;

    const text = event.text.trim();
    const spaceIdx = text.indexOf(" ");
    const cmdName = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
    const arg = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";

    log.debug(`browser command: /${cmdName} ${arg.slice(0, 80)}`);

    const handler = commandHandlerRegistry.get(cmdName);
    if (handler) {
      try {
        const rawCtx = firstLiveExtensionCtx(lastCmdCtx, execCtx, client.lastCtx);
        if (!rawCtx) {
          log.debug(`browser command /${cmdName} skipped — no live ctx`);
          return { action: "handled" as const };
        }
        const ctx = rawCtx?.ui ? { ...rawCtx, ui: { ...rawCtx.ui, notify: (msg: string, level?: string) => {
          client.send({ type: "notification", level: level || "info", message: String(msg) });
          return rawCtx.ui.notify(msg, level);
        } } } : Object.create(rawCtx);
        // Tag the copy: a command from the browser must not open a terminal-only overlay its
        // user cannot see or drive (#1082). The live ctx object is never mutated.
        markBrowserDispatch(ctx);
        await handler(arg, ctx);
      } catch (e: any) {
        log.error(`command /${cmdName} error:`, e);
      }
      return { action: "handled" as const };
    }
    // Unknown command from browser — send error notification
    client.send({ type: "notification", level: "warning", message: `Unknown command: /${cmdName}` });
    return { action: "handled" as const };
  }

  // ── Wire everything up ─────────────────────────────────────────────

  setupEventForwarding();
  setupPidashEventListeners();
  statusInterval = setupPeriodicStatus();

  pi.on("session_start", (event: any, ctx: any) => { if (client.shuttingDown) return; handleSessionStart(event, ctx); });

  commandHandlerRegistry.set("pidash", (args, ctx) => client.handleCommand(args, ctx));

  pi.on("input", async (event, _ctx) => { if (client.shuttingDown) return; return handleBrowserInput(event, _ctx); });

  // Auto-name session from first user prompt if no name set
  let sessionNamed = false;
  pi.on("agent_end" as any, () => {
    if (sessionNamed || client.shuttingDown) return;
    const currentName = (pi as any).getSessionName?.();
    if (currentName) { sessionNamed = true; return; }
    try {
      const entries = client.lastCtx?.sessionManager?.getEntries?.() || [];
      const firstUser = entries.find((e: any) => e.type === "message" && e.message?.role === "user");
      if (firstUser) {
        const content = firstUser.message.content;
        const text = typeof content === "string" ? content :
          Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
        if (text) {
          const name = text.slice(0, 60).replace(/\n/g, " ").trim();
          (pi as any).setSessionName?.(name);
          sessionNamed = true;
          log.debug("auto_session_name", name);
        }
      }
    } catch (e: any) { log.debug("auto_session_name_error", e?.message); }
  });
}
