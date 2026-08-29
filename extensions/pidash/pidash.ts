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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { setupHeartbeat, setupReconnectPoller } from "../shared/ws-client.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { checkHealth, ensureUiBuilt, spawnDaemon as spawnDaemonGeneric, killDaemon } from "../shared/daemon-manager.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { shouldSkipOneshotRegister } from "../shared/oneshot.js";
import { firstLiveExtensionCtx, isLiveExtensionCtx, resolveSessionStartCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("pidash");

// Module-level ref — survives closure replacement on /reload.
// raceWithBrowser captures `pi` from the closure, but after reload
// the old `pi` is stale (assertActive throws). This ref is updated
// on each extension factory call so event listeners always use the
// current runtime.
let currentPiEvents: any = null;

const RECONNECT_INTERVAL_MS = 5000;

// ── Helpers ──────────────────────────────────────────────────────────

function isDaemonRunning(port: number): Promise<boolean> {
  return checkHealth(port);
}

function spawnDaemon(port: number): void {
  ensureUiBuilt(import.meta.url, "pidash-ui", (msg) => log.debug(msg));
  spawnDaemonGeneric({
    serverScript: "pidash-server.ts",
    logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidash-server.log"),
    env: { PI_PIDASH_PORT: String(port) },
    log: (msg) => log.debug(msg),
  });
}

function getGitStatus(cwd: string): { branch: string; dirty: boolean; changes: number } {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const changes = status ? status.split("\n").length : 0;
    return { branch, dirty: changes > 0, changes };
  } catch { return { branch: "", dirty: false, changes: 0 }; }
}

function isContainer(): boolean {
  try {
    return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
  } catch { return false; }
}

function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
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
    pi.registerCommand("pidash", {
      description: "Manage pidash server — /pidash start|stop|restart|status",
      getArgumentCompletions: (prefix: string) => {
        const items = [
          { value: "start", label: "start", description: "Start pidash server" },
          { value: "stop", label: "stop", description: "Stop pidash server" },
          { value: "restart", label: "restart", description: "Restart pidash server" },
          { value: "status", label: "status", description: "Show pidash status" },
        ];
        return items.filter(i => i.value.startsWith(prefix.toLowerCase()));
      },
      handler: async (_args, ctx) => {
        if (ctx.hasUI) ctx.ui.notify("pidash is disabled (pidash_enable=false in pi-config-settings.json or PI_PIDASH_ENABLE=false).", "info");
      },
    });
    return;
  }

  // ── Closure state ──────────────────────────────────────────────────

  let ws: any = null;
  let connected = false;
  let connecting = false;
  let shuttingDown = false;
  let spawning = false;
  let lastCtx: any = null;
  let lastCmdCtx: any = null;  // Command context with switchSession — updated by /pidash handler
  let cleanupHeartbeat: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionId = `${process.pid}:${process.cwd()}`;
  const eventBuffer: string[] = []; // Buffer events for replay on daemon reconnect
  let activitySequence = 0;
  let activity: "working" | "waiting_for_input" | "idle" = "idle";
  let connectionGeneration = 0;
  let execCtx: any = null;
  let comsIdentityName: string | undefined;
  let comsIdentityPurpose: string | undefined;
  let comsIdentityProject: string | undefined;
  const commandHandlerRegistry = new Map<string, (args: string, ctx: any) => Promise<void> | void>();

  // Listen for coms identity — coms ext emits this after boot
  pi.events.on("pidash:coms-identity", (data: any) => {
    comsIdentityName = data?.name;
    comsIdentityPurpose = data?.purpose;
    comsIdentityProject = data?.project;
    log.debug("coms_identity_received", comsIdentityName);
    if (ws && connected) {
      try { ws.send(JSON.stringify({ type: "update_info", comsName: comsIdentityName, comsPurpose: comsIdentityPurpose, comsProject: comsIdentityProject })); } catch {}
    }
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
  pi.events.emit("pidash:request-commands");

  // Capture command context from orchestrator
  // TODO: Remove once pidash uses PiClient/RemoteSession (#732)
  pi.events.on("pidash:command-ctx", (ctx: unknown) => {
    if (ctx && typeof (ctx as any)?.switchSession === "function") {
      lastCmdCtx = ctx as any;
    }
  });

  // ── Extracted inner functions ──────────────────────────────────────

  /** Replay session history to the WebSocket client for browser display. */
  function replaySessionHistory(wsClient: any, ctx: any, pushBuffered: (ev: string) => void): void {
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

          // Send tool calls
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              const toolEv = JSON.stringify({
                type: "tool_execution_start",
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

        // Tool results
        if (msg.role === "toolResult") {
          const resultEv = JSON.stringify({
            type: "tool_execution_end",
            toolName: msg.toolName,
            result: { content: msg.content },
            isError: msg.isError || false,
            timestamp: ts,
          });
          pushBuffered(resultEv);
        }

        // Custom messages (async agent results, etc.)
        if (msg.role === "custom" && msg.display) {
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
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

    // Signal replay is complete so the server can stop suppressing notifications
    try { wsClient.send(JSON.stringify({ type: "replay_complete" })); } catch {}
  }

  /** Handle incoming WebSocket messages from the pidash daemon (prompts, commands). */
  async function handleWsMessage(data: Buffer): Promise<void> {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "prompt" && (parsed.text || parsed.images)) {
        log.debug(`received prompt from browser: ${(parsed.text || "").slice(0, 100)}${parsed.images ? ` [+${parsed.images.length} images]` : ""}`);
        // Notify browser if prompt is queued during streaming
        if (isStreaming && ws && connected) {
          try { ws.send(JSON.stringify({ type: "prompt-queued" })); } catch (e: any) { log.debug(`prompt-queued send error: ${e.message}`); }
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
            const sessions = await SessionManager.list(lastCtx?.cwd || process.cwd());
            log.debug(`list-sessions: found ${sessions.length}`);
            if (ws && connected) ws.send(JSON.stringify({ type: "sessions-list", sessions }));
          } catch (e: any) { log.debug(`list-sessions error: ${e.message}`); }
        }

        if (parsed.command === "list-models") {
          try {
            if (lastCtx?.modelRegistry) {
              const available = lastCtx.modelRegistry.getAvailable();
              const list = available.map((m: any) => ({
                id: m.id,
                name: m.name,
                provider: typeof m.provider === "string" ? m.provider : m.provider?.name || "",
              }));
              log.debug(`models found: ${list.length}`);
              if (ws && connected) ws.send(JSON.stringify({ type: "models-list", models: list }));
            } else {
              log.debug("list-models: no modelRegistry on ctx");
            }
          } catch (e: any) { log.debug(`list-models error: ${e.message}`); }
        }

        if (parsed.command === "set-model" && parsed.modelId) {
          try {
            const model = lastCtx?.modelRegistry?.getAvailable()?.find((m: any) =>
              m.id === parsed.modelId || m.name === parsed.modelId || m.id.includes(parsed.modelId) || m.name.includes(parsed.modelId));
            if (model) {
              await (pi as any).setModel(model);
              log.debug(`model set to: ${model.name}`);
              ws.send(JSON.stringify({ type: "update_info", model: model.name, contextWindow: model.contextWindow || 0 }));
            }
          } catch (e: any) { log.debug(`set-model error: ${e.message}`); }
        }

        if (parsed.command === "set-thinking" && parsed.level) {
          try {
            (pi as any).setThinkingLevel(parsed.level);
            log.debug(`thinking set to: ${parsed.level}`);
            ws.send(JSON.stringify({ type: "update_info", thinkingLevel: parsed.level }));
          } catch (e: any) { log.debug(`set-thinking error: ${e.message}`); }
        }

        if (parsed.command === "switch-session" && parsed.sessionFile) {
          log.debug(`switch-session: ${parsed.sessionFile}`);
          const ctx = lastCmdCtx ?? lastCtx;
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
          if (lastCtx) {
            try { lastCtx.abort(); log.debug("abort sent"); } catch {}
          }
        }

        if (parsed.command === "async-kill" && parsed.target) {
          log.debug(`async-kill from browser: ${parsed.target}`);
          pi.events.emit("pidash:async-kill", parsed.target);
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
              if (ws && connected) {
                try { ws.send(JSON.stringify({ type: "update_info", name: newName })); } catch {}
              }
            } catch (e: any) { log.debug(`rename-session error: ${e.message}`); }
          }
        }

        if (parsed.command === "list-commands") {
          try {
            const cmds = (pi as any).getCommands?.() || [];
            const list = cmds.map((c: any) => ({ name: c.name, description: c.description || "" }));
            if (ws && connected) ws.send(JSON.stringify({ type: "commands-list", commands: list }));
          } catch (e: any) { log.debug(`list-commands error: ${e.message}`); }
        }

      }
    } catch (e: any) { log.debug(`message handler error: ${e.message}`); }
  }

  /** Handle /pidash command (start|stop|restart|status). */
  async function handlePidashCommand(args: string, ctx: any): Promise<void> {
    lastCmdCtx = ctx;
    // Guard: pidash daemon connections only in TUI mode
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("pidash is only available in TUI mode.", "info");
      return;
    }

    execCtx = ctx;

    const cmd = (args || "").trim().toLowerCase();

    if (cmd === "stop") {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
      killDaemon("pidash-server", (msg) => log.debug(msg));
      if (ctx.hasUI) {
        ctx.ui.setStatus("9-pidash", undefined);
        ctx.ui.notify("pidash server stopped", "info");
      }
      return;
    }

    if (cmd === "start") {
      if (await isDaemonRunning(pidashPort)) {
        if (ctx.hasUI) ctx.ui.notify(`pidash already running at http://localhost:${pidashPort}`, "info");
        if (!connected) connect(ctx);
        return;
      }
      spawnDaemon(pidashPort);
      if (ctx.hasUI) ctx.ui.notify("Starting pidash server...", "info");
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning(pidashPort)) break;
      }
      if (await isDaemonRunning(pidashPort)) {
        connect(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pidash server started at http://localhost:${pidashPort}`, "info");
      } else {
        if (ctx.hasUI) ctx.ui.notify("pidash server failed to start — check ~/.pi/pidash-server.log", "warning");
      }
      return;
    }

    if (cmd === "restart") {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
      killDaemon("pidash-server", (msg) => log.debug(msg));
      await new Promise(r => setTimeout(r, 1000));
      spawnDaemon(pidashPort);
      if (ctx.hasUI) ctx.ui.notify("Restarting pidash server...", "info");
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning(pidashPort)) break;
      }
      if (await isDaemonRunning(pidashPort)) {
        connect(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pidash server restarted at http://localhost:${pidashPort}`, "info");
      } else {
        if (ctx.hasUI) ctx.ui.notify("pidash server failed to restart — check ~/.pi/pidash-server.log", "warning");
      }
      return;
    }

    if (cmd === "status" || cmd === "") {
      const running = await isDaemonRunning(pidashPort);
      let msg = `Server: ${running ? "running" : "stopped"}\n`;
      msg += `Port: ${pidashPort}\n`;
      msg += `Extension: ${connected ? "connected" : "disconnected"}\n`;
      msg += `URL: http://localhost:${pidashPort}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      return;
    }

    if (ctx.hasUI) ctx.ui.notify("Usage: /pidash start|stop|restart|status", "info");
  }

  // ── connect() ──────────────────────────────────────────────────────

  async function connect(ctx: any) {
    if (connected || connecting || shuttingDown) return;
    // Guard against stale ctx from surviving setTimeout after reload
    if (!isLiveExtensionCtx(ctx)) {
      log.debug("connect() skipped — stale ctx");
      return;
    }
    log.debug(`connect() called, connected=${connected}, connecting=${connecting}, shuttingDown=${shuttingDown}, cwd=${ctx?.cwd}`);
    connecting = true;
    lastCtx = ctx;

    const running = await isDaemonRunning(pidashPort);
    log.debug(`daemon running: ${running}`);
    if (!running) {
      if (spawning) {
        log.debug("daemon already spawning, waiting...");
      } else {
        spawning = true;
        log.debug("spawning daemon...");
        spawnDaemon(pidashPort);
      }
      // jiti cold compilation can take 30+ seconds on first run
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning(pidashPort)) {
          log.debug(`daemon ready after ${i + 1}s`);
          break;
        }
      }
      if (!(await isDaemonRunning(pidashPort))) {
        log.debug("daemon failed to start after 60s");
        spawning = false;
        connecting = false;
        return;
      }
      spawning = false;
    }

    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      log.debug("creating WebSocket client...");
      const wsClient = new WebSocket(`ws://127.0.0.1:${pidashPort}/ws/pi`);
      const thisConnectionGeneration = ++connectionGeneration;

      wsClient.on("open", () => {
        log.debug("WebSocket connected!");
        ws = wsClient;
        connected = true;
        connecting = false;

        try {
        // Register this session
        const git = getGitStatus(ctx.cwd);
        const m = ctx.model;
        // Read thinking level from session entries
        let thinking = "medium";
        try {
          thinking = (pi as any).getThinkingLevel?.() || "medium";
        } catch (e: any) { log.debug(`getThinkingLevel failed: ${e?.message || e}`); }
        const reg = JSON.stringify({
          type: "register",
          pid: process.pid,
          sessionId,
          connectionGeneration: thisConnectionGeneration,
          cwd: ctx.cwd,
          branch: git.branch,
          gitDirty: git.dirty,
          gitChanges: git.changes,
          container: isContainer(),
          model: m?.name || m?.id || "",
          contextWindow: m?.contextWindow || 0,
          startedAt: new Date().toISOString(),
          activity,
          activitySequence,
          streaming: isStreaming,
          sessionFile: ctx.sessionManager?.getSessionFile?.() || ctx.sessionFile || "",
          thinkingLevel: thinking,
          diffPort,
          name: (pi as any).getSessionName?.() || undefined,
          comsName: comsIdentityName || (pi as any).getFlag?.("cname") || undefined,
          comsPurpose: comsIdentityPurpose || (pi as any).getFlag?.("purpose") || undefined,
          comsProject: comsIdentityProject || undefined,
        });
        log.debug(`sending register: ${reg}`);
        wsClient.send(reg);

        // Always load history from session file (source of truth)
        eventBuffer.length = 0;
        const pushBuffered = (ev: string) => {
          wsClient.send(ev);
          eventBuffer.push(ev);
          while (eventBuffer.length > 10000) eventBuffer.shift();
        };
        replaySessionHistory(wsClient, ctx, pushBuffered);

        } catch (err) {
          // ctx may be stale if session was replaced during WebSocket connect
          log.debug(`open handler error (likely stale ctx): ${err}`);
        }

        // Keepalive + dead connection detection
        if (cleanupHeartbeat) cleanupHeartbeat();
        cleanupHeartbeat = setupHeartbeat({
          ws: wsClient,
          log: (msg) => log.debug(msg),
          onDead: () => {
            connected = false;
            ws = null;
            if (!shuttingDown && lastCtx) {
              if (reconnectTimer) clearTimeout(reconnectTimer);
              reconnectTimer = setTimeout(() => { reconnectTimer = null; if (lastCtx && !shuttingDown) connect(lastCtx); }, 1000);
            }
          },
        });

        // Show status
        try {
          if (ctx.hasUI) {
            const link = hyperlink("pi-dash", `http://localhost:${pidashPort}`);
            ctx.ui.setStatus("9-pidash", ctx.ui.theme.fg("accent", link));
          }
        } catch {
          // ctx may be stale if session was replaced during WebSocket connect
        }
      });

      wsClient.on("message", (data: Buffer) => { handleWsMessage(data); });

      wsClient.on("close", (code: number, reason: Buffer) => {
        log.debug(`WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
        connecting = false;
        log.debug("WebSocket closed");
        connected = false;
        ws = null;
        if (!shuttingDown) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { reconnectTimer = null; if (lastCtx && !shuttingDown) connect(lastCtx); }, RECONNECT_INTERVAL_MS);
        }
      });

      wsClient.on("error", (e: Error) => {
        log.debug(`WebSocket error: ${e.message}`);
      });
    } catch (e: any) {
      log.debug(`connect error: ${e.message}`);
      connecting = false;
    }
  }

  // ── forward() helper ──────────────────────────────────────────────

  // Forward events to daemon
  function forward(type: string) {
    pi.on(type as any, (event: any, ctx: any) => {
      if (shuttingDown) return;
      lastCtx = ctx;
      let payload: any = { type, ...event, timestamp: Date.now() };
      if (["agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end"].includes(type)) {
        payload.activitySequence = ++activitySequence;
        if (type === "agent_start" || type === "ui_prompt_end") activity = "working";
        else if (type === "ui_prompt_start") activity = "waiting_for_input";
        else if (type === "agent_end") activity = "idle";
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
      if (type !== "extension_ui_request") {
        eventBuffer.push(msg);
        // Cap incremental buffer — session file is the source of truth for full history
        while (eventBuffer.length > 10000) eventBuffer.shift();
      }
      if (ws && connected) {
        try { ws.send(msg); } catch (e: any) { log.debug(`forward ${type} error: ${e.message}`); }
      } else if (!connected) {
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
    pi.on("agent_start", () => { if (shuttingDown) return; isStreaming = true; });
    pi.on("agent_settled", () => { if (shuttingDown) return; isStreaming = false; });
    forward("turn_start");
    forward("turn_end");
    forward("message_start");
    forward("message_update");
    forward("message_end");
    forward("tool_execution_start");
    forward("tool_execution_update");
    forward("tool_execution_end");
    forward("tool_call");
    forward("tool_result");
    forward("session_info_changed");

    pi.on("model_select", (event: any) => {
      if (shuttingDown) return;
      if (ws && connected) {
        ws.send(JSON.stringify({
          type: "update_info",
          model: event.model?.name || event.model?.id || "",
          contextWindow: event.model?.contextWindow || 0,
        }));
      }
    });

    // Sync thinking level on every turn
    pi.on("turn_end", () => {
      if (shuttingDown) return;
      if (!ws || !connected) return;
      try {
        const level = (pi as any).getThinkingLevel?.();
        if (level) ws.send(JSON.stringify({ type: "update_info", thinkingLevel: level }));
      } catch {}
    });

    // Track diff viewer port
    pi.events.on("diff-viewer:port", (port: unknown) => {
      if (typeof port === "number") {
        diffPort = port;
        if (ws && connected) {
          ws.send(JSON.stringify({ type: "update_info", diffPort: port }));
        }
      }
    });

    // Forward provider response info to pidash
    pi.on("after_provider_response" as any, (event: any) => {
      if (shuttingDown) return;
      if (!ws || !connected) return;
      try {
        const info: any = { type: "provider_response" };
        if (event.status) info.status = event.status;
        if (event.headers) {
          if (event.headers["x-ratelimit-remaining"]) info.rateLimitRemaining = event.headers["x-ratelimit-remaining"];
          if (event.headers["x-ratelimit-reset"]) info.rateLimitReset = event.headers["x-ratelimit-reset"];
          if (event.headers["retry-after"]) info.retryAfter = event.headers["retry-after"];
          if (event.headers["x-request-id"]) info.requestId = event.headers["x-request-id"];
        }
        ws.send(JSON.stringify(info));
      } catch (e: any) { log.debug(`provider response forward error: ${e.message}`); }
    });
  }

  /** Register pi.events.on() listeners for pidash-specific events. */
  function setupPidashEventListeners(): void {
    // Forward ask_user requests to the daemon for browser display
    pi.events.on("pidash:ui-request", (data: unknown) => {
      if (ws && connected) {
        try { ws.send(JSON.stringify(data)); } catch {}
      }
    });

    // Forward dialog dismissals to the browser
    pi.events.on("pidash:ui-dismiss", (data: unknown) => {
      if (ws && connected) {
        try { ws.send(JSON.stringify(data)); } catch {}
      }
    });

    // Forward async agent status to browser
    pi.events.on("pidash:async-status", (data: unknown) => {
      if (ws && connected) {
        try { ws.send(JSON.stringify({ type: "async-status", ...(data as any) })); } catch {}
      }
    });

    // Forward cron status to browser
    pi.events.on("pidash:cron-status", (data: unknown) => {
      if (ws && connected) {
        try { ws.send(JSON.stringify({ type: "cron-status", ...(data as any) })); } catch {}
      }
    });

    // Forward coms peer join/leave events to browser
    pi.events.on("pidash:coms-peer-event", (data: unknown) => {
      const d = data as { customType?: string; content?: string };
      if (!d?.customType) return;
      if (ws && connected) {
        try { ws.send(JSON.stringify({ type: "coms_peer_event", customType: d.customType, content: d.content || "" })); } catch {}
      }
    });

  }

  /** Periodically send git status updates to the daemon. */
  function setupPeriodicStatus(): ReturnType<typeof setInterval> {
    const statusInterval = setInterval(() => {
      if (shuttingDown || !ws || !connected || !lastCtx) return;
      if (!isLiveExtensionCtx(lastCtx)) {
        log.debug("periodic status stopped — stale ctx after session replacement");
        lastCtx = null;
        return;
      }
      if (lastCtx.mode !== "tui") return;
      try {
        const git = getGitStatus(lastCtx.cwd);
        ws.send(JSON.stringify({
          type: "update_info",
          branch: git.branch,
          gitDirty: git.dirty,
          gitChanges: git.changes,
        }));
      } catch (e: any) { log.debug(`periodic status error: ${e?.message || e}`); }
    }, 10000);
    if (statusInterval.unref) statusInterval.unref();
    return statusInterval;
  }

  /** Handle session_start event — connect or notify session switch. */
  function handleSessionStart(event: any, ctx: any): void {
    sessionNamed = false;
    log.debug("session_start", (event as any)?.reason);

    const resolved = resolveSessionStartCtx(lastCtx, ctx);
    lastCtx = resolved.lastCtx;
    execCtx = resolved.execCtx;
    if (execCtx) log.debug("execCtx set from session_start");
    else log.debug("session_start: execCtx cleared — no live ctx");
    if (lastCtx === ctx) log.debug("lastCtx updated from session_start");

    const switchCtx = resolved.switchCtx;
    // Auto-capture command context: silently run /pidash status.
    // pi.sendUserMessage won't trigger command dispatch (expandPromptTemplates: false),
    // so we call the handler directly. The context won't have switchSession yet,
    // but the /pidash handler will be called with a real ExtensionCommandContext
    // when the user types their first prompt (via before_agent_start triggering
    // the input pipeline). For now, this at least initializes the connection.
    // Session switching requires the user to have typed at least one slash command.
    if (!connected && switchCtx && switchCtx.mode === "tui") {
      connect(switchCtx);
    } else if (ws) {
      if (!switchCtx) {
        log.debug("session_switch skipped — no live ctx");
        return;
      }
      // Already connected — session switched (e.g., /resume, /new)
      eventBuffer.length = 0; // Clear stale events to prevent cross-session replay on reconnect
      activitySequence = 0;
      activity = "idle";
      ws.send(JSON.stringify({
        type: "session_switch",
        sessionId,
        cwd: switchCtx.cwd,
        branch: getCurrentBranch(switchCtx.cwd),
        sessionFile: switchCtx.sessionManager?.getSessionFile?.() || switchCtx.sessionFile || "",
      }));
      log.debug(`session_switch sent: cwd=${switchCtx.cwd}`);
    }
  }

  /** Handle input event — intercept extension commands from browser. */
  async function handleBrowserInput(event: any, _ctx: any): Promise<{ action: "handled" } | void> {
    if ((event as any).streamingBehavior && ws && connected) {
      try { ws.send(JSON.stringify({ type: "streaming-behavior", behavior: (event as any).streamingBehavior })); }
      catch (e: any) { log.debug(`streaming-behavior send error: ${e.message}`); }
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
        const rawCtx = firstLiveExtensionCtx(lastCmdCtx, execCtx, lastCtx);
        if (!rawCtx) {
          log.debug(`browser command /${cmdName} skipped — no live ctx`);
          return { action: "handled" as const };
        }
        const ctx = rawCtx?.ui ? { ...rawCtx, ui: { ...rawCtx.ui, notify: (msg: string, level?: string) => {
          if (ws && connected) { try { ws.send(JSON.stringify({ type: "notification", level: level || "info", message: String(msg) })); } catch {} }
          return rawCtx.ui.notify(msg, level);
        } } } : rawCtx;
        await handler(arg, ctx);
      } catch (e: any) {
        log.error(`command /${cmdName} error:`, e);
      }
      return { action: "handled" as const };
    }
    // Unknown command from browser — send error notification
    if (ws && connected) {
      try { ws.send(JSON.stringify({ type: "notification", level: "warning", message: `Unknown command: /${cmdName}` })); } catch {}
    }
    return { action: "handled" as const };
  }

  // ── Wire everything up ─────────────────────────────────────────────

  setupEventForwarding();
  setupPidashEventListeners();
  const statusInterval = setupPeriodicStatus();

  pi.on("session_start", (event: any, ctx: any) => { if (shuttingDown) return; handleSessionStart(event, ctx); });

  // Fallback for /reload — connect on first tool_result if not connected
  pi.on("tool_result", (_event, ctx) => {
    if (shuttingDown) return;
    if (!connected && !shuttingDown && isLiveExtensionCtx(ctx) && ctx.mode === "tui") connect(ctx);
  });

  // Periodic reconnect — ensures sessions that started before the daemon still connect
  const cleanupReconnect = setupReconnectPoller({
    isConnected: () => connected,
    isConnecting: () => connecting,
    isShuttingDown: () => shuttingDown,
    connect: () => {
      if (!isLiveExtensionCtx(lastCtx)) {
        if (lastCtx) {
          log.debug("reconnect poller skipped — stale ctx");
          lastCtx = null;
        }
        return;
      }
      if (lastCtx.mode === "tui") connect(lastCtx);
    },
  });

  // ── Command execution from browser ────────────────────────────────
  //
  // Problem: pi.sendUserMessage() disables command handling (expandPromptTemplates: false).
  // Solution: Register a command that can execute other commands, and intercept
  // browser-sourced / messages in the input event to route through it.

  // Hidden command that captures ExtensionCommandContext
  // Called once at startup via /pidash, then reused for all browser commands
  pi.registerCommand("pidash", {
    description: "Manage pidash server — /pidash start|stop|restart|status",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "start", label: "start", description: "Start pidash server" },
        { value: "stop", label: "stop", description: "Stop pidash server" },
        { value: "restart", label: "restart", description: "Restart pidash server" },
        { value: "status", label: "status", description: "Show pidash status" },
      ];
      return items.filter(i => i.value.startsWith(prefix.toLowerCase()));
    },
    handler: (args, ctx) => handlePidashCommand(args, ctx),
  });
  commandHandlerRegistry.set("pidash", (args, ctx) => handlePidashCommand(args, ctx));

  pi.on("input", async (event, _ctx) => { if (shuttingDown) return; return handleBrowserInput(event, _ctx); });

  // Auto-name session from first user prompt if no name set
  let sessionNamed = false;
  pi.on("agent_end" as any, () => {
    if (sessionNamed || shuttingDown) return;
    const currentName = (pi as any).getSessionName?.();
    if (currentName) { sessionNamed = true; return; }
    try {
      const entries = lastCtx?.sessionManager?.getEntries?.() || [];
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

  pi.on("session_shutdown", (event) => {
    // Forward shutdown reason to pidash dashboard
    if (ws && connected) {
      try {
        ws.send(JSON.stringify({
          type: "session_shutdown",
          reason: (event as any).reason,
          targetSessionFile: (event as any).targetSessionFile,
        }));
      } catch {}
    }
    shuttingDown = true;
    clearInterval(statusInterval);
    cleanupReconnect();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (cleanupHeartbeat) { cleanupHeartbeat(); cleanupHeartbeat = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
  });
}
