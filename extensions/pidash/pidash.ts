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
// Command handler registry — standalone, populated via pi.events from other extensions
const commandHandlerRegistry = new Map<string, (args: string, ctx: any) => Promise<void>>();
import { checkHealth, ensureUiBuilt, spawnDaemon as spawnDaemonGeneric, killDaemon, createLogger } from "../shared/daemon-manager.js";

const DEFAULT_PORT = 19190;
const PIDASH_PORT = parseInt(process.env.PI_PIDASH_PORT || "", 10) || DEFAULT_PORT;
const RECONNECT_INTERVAL_MS = 5000;

const debugLog = createLogger(
  path.join(process.env.HOME || "/tmp", ".pi", "pidash-debug.log"),
  "ext",
);

// ── Helpers ──────────────────────────────────────────────────────────

function isDaemonRunning(): Promise<boolean> {
  return checkHealth(PIDASH_PORT);
}

function spawnDaemon(): void {
  ensureUiBuilt(import.meta.url, "pidash-ui", debugLog);
  spawnDaemonGeneric({
    serverScript: "pidash-server.ts",
    logFile: path.join(process.env.HOME || "/tmp", ".pi", "pidash-server.log"),
    env: { PI_PIDASH_PORT: String(PIDASH_PORT) },
    log: debugLog,
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

  const pidashDisabled = ["false", "0", "no", "off"].includes(process.env.PI_PIDASH_ENABLE?.toLowerCase() ?? "");
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
        if (ctx.hasUI) ctx.ui.notify("pidash is disabled (PI_PIDASH_ENABLE=false). Set PI_PIDASH_ENABLE=true or unset it to enable.", "info");
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
  let cleanupHeartbeat: (() => void) | null = null;
  const sessionId = `${process.pid}:${process.cwd()}`;
  const eventBuffer: string[] = []; // Buffer events for replay on daemon reconnect
  let execCtx: any = null;
  let pidashCommandCtx: any = null;  // Real ExtensionCommandContext from /pidash handler

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
      if (historyCount > 0) debugLog(`loaded ${historyCount} entries from session history`);
    } catch (e: any) {
      debugLog(`session history load error: ${e.message}`);
    }

    // Signal replay is complete so the server can stop suppressing notifications
    try { wsClient.send(JSON.stringify({ type: "replay_complete" })); } catch {}
  }

  /** Handle incoming WebSocket messages from the pidash daemon (prompts, commands). */
  async function handleWsMessage(data: Buffer): Promise<void> {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "prompt" && (parsed.text || parsed.images)) {
        debugLog(`received prompt from browser: ${(parsed.text || "").slice(0, 100)}${parsed.images ? ` [+${parsed.images.length} images]` : ""}`);
        // Notify browser if prompt is queued during streaming
        if (isStreaming && ws && connected) {
          try { ws.send(JSON.stringify({ type: "prompt-queued" })); } catch (e: any) { debugLog(`prompt-queued send error: ${e.message}`); }
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
        debugLog(`received UI response from browser: ${JSON.stringify(parsed).slice(0, 100)}`);
        pi.events.emit("pidash:ui-response", parsed);
      }
      if (parsed.type === "pidash-command") {
        debugLog(`received command from browser: ${parsed.command}`);

        if (parsed.command === "list-sessions") {
          try {
            const sessions = await SessionManager.list(lastCtx?.cwd || process.cwd());
            debugLog(`list-sessions: found ${sessions.length}`);
            if (ws && connected) ws.send(JSON.stringify({ type: "sessions-list", sessions }));
          } catch (e: any) { debugLog(`list-sessions error: ${e.message}`); }
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
              debugLog(`models found: ${list.length}`);
              if (ws && connected) ws.send(JSON.stringify({ type: "models-list", models: list }));
            } else {
              debugLog("list-models: no modelRegistry on ctx");
            }
          } catch (e: any) { debugLog(`list-models error: ${e.message}`); }
        }

        if (parsed.command === "set-model" && parsed.modelId) {
          try {
            const model = lastCtx?.modelRegistry?.getAvailable()?.find((m: any) =>
              m.id === parsed.modelId || m.name === parsed.modelId || m.id.includes(parsed.modelId) || m.name.includes(parsed.modelId));
            if (model) {
              await (pi as any).setModel(model);
              debugLog(`model set to: ${model.name}`);
              ws.send(JSON.stringify({ type: "update_info", model: model.name, contextWindow: model.contextWindow || 0 }));
            }
          } catch (e: any) { debugLog(`set-model error: ${e.message}`); }
        }

        if (parsed.command === "set-thinking" && parsed.level) {
          try {
            (pi as any).setThinkingLevel(parsed.level);
            debugLog(`thinking set to: ${parsed.level}`);
            ws.send(JSON.stringify({ type: "update_info", thinkingLevel: parsed.level }));
          } catch (e: any) { debugLog(`set-thinking error: ${e.message}`); }
        }

        if (parsed.command === "switch-session" && parsed.sessionFile) {
          debugLog(`switch-session: ${parsed.sessionFile}`);
          const ctx = pidashCommandCtx;
          if (ctx?.switchSession) {
            try {
              await ctx.switchSession(parsed.sessionFile, {
                withSession: async () => {
                  debugLog("switch-session: completed");
                },
              });
            } catch (e: any) {
              debugLog(`switch-session error: ${e.message}`);
            }
          } else {
            debugLog("switch-session: no command context available");
          }
        }

        if (parsed.command === "abort") {
          if (lastCtx) {
            try { lastCtx.abort(); debugLog("abort sent"); } catch {}
          }
        }

        if (parsed.command === "async-kill" && parsed.target) {
          debugLog(`async-kill from browser: ${parsed.target}`);
          pi.events.emit("pidash:async-kill", parsed.target);
        }

        if (parsed.command === "cron-kill" && parsed.target) {
          debugLog(`cron-kill from browser: ${parsed.target}`);
          pi.events.emit("pidash:cron-kill", parsed.target);
        }

        if (parsed.command === "list-commands") {
          try {
            const cmds = (pi as any).getCommands?.() || [];
            const list = cmds.map((c: any) => ({ name: c.name, description: c.description || "" }));
            if (ws && connected) ws.send(JSON.stringify({ type: "commands-list", commands: list }));
          } catch (e: any) { debugLog(`list-commands error: ${e.message}`); }
        }

      }
    } catch (e: any) { debugLog(`message handler error: ${e.message}`); }
  }

  /** Handle /pidash command (start|stop|restart|status). */
  async function handlePidashCommand(args: string, ctx: any): Promise<void> {
    // Guard: pidash daemon connections only in TUI mode
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("pidash is only available in TUI mode.", "info");
      return;
    }

    execCtx = ctx;
    pidashCommandCtx = ctx;  // Real ExtensionCommandContext
    debugLog("pidashCommandCtx captured from /pidash handler");

    const cmd = (args || "").trim().toLowerCase();

    if (cmd === "stop") {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
      killDaemon("pidash-server", debugLog);
      if (ctx.hasUI) {
        ctx.ui.setStatus("9-pidash", undefined);
        ctx.ui.notify("pidash server stopped", "info");
      }
      return;
    }

    if (cmd === "start") {
      if (await isDaemonRunning()) {
        if (ctx.hasUI) ctx.ui.notify(`pidash already running at http://localhost:${PIDASH_PORT}`, "info");
        if (!connected) connect(ctx);
        return;
      }
      spawnDaemon();
      if (ctx.hasUI) ctx.ui.notify("Starting pidash server...", "info");
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning()) break;
      }
      if (await isDaemonRunning()) {
        connect(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pidash server started at http://localhost:${PIDASH_PORT}`, "info");
      } else {
        if (ctx.hasUI) ctx.ui.notify("pidash server failed to start — check ~/.pi/pidash-server.log", "warning");
      }
      return;
    }

    if (cmd === "restart") {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
      killDaemon("pidash-server", debugLog);
      await new Promise(r => setTimeout(r, 1000));
      spawnDaemon();
      if (ctx.hasUI) ctx.ui.notify("Restarting pidash server...", "info");
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning()) break;
      }
      if (await isDaemonRunning()) {
        connect(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pidash server restarted at http://localhost:${PIDASH_PORT}`, "info");
      } else {
        if (ctx.hasUI) ctx.ui.notify("pidash server failed to restart — check ~/.pi/pidash-server.log", "warning");
      }
      return;
    }

    if (cmd === "status" || cmd === "") {
      const running = await isDaemonRunning();
      let msg = `Server: ${running ? "running" : "stopped"}\n`;
      msg += `Port: ${PIDASH_PORT}\n`;
      msg += `Extension: ${connected ? "connected" : "disconnected"}\n`;
      msg += `URL: http://localhost:${PIDASH_PORT}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      return;
    }

    if (ctx.hasUI) ctx.ui.notify("Usage: /pidash start|stop|restart|status", "info");
  }

  // ── connect() ──────────────────────────────────────────────────────

  async function connect(ctx: any) {
    debugLog(`connect() called, connected=${connected}, connecting=${connecting}, shuttingDown=${shuttingDown}, cwd=${ctx?.cwd}`);
    if (connected || connecting || shuttingDown) return;
    connecting = true;
    lastCtx = ctx;

    const running = await isDaemonRunning();
    debugLog(`daemon running: ${running}`);
    if (!running) {
      if (spawning) {
        debugLog("daemon already spawning, waiting...");
      } else {
        spawning = true;
        debugLog("spawning daemon...");
        spawnDaemon();
      }
      // jiti cold compilation can take 30+ seconds on first run
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning()) {
          debugLog(`daemon ready after ${i + 1}s`);
          break;
        }
      }
      if (!(await isDaemonRunning())) {
        debugLog("daemon failed to start after 60s");
        spawning = false;
        connecting = false;
        return;
      }
      spawning = false;
    }

    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      debugLog("creating WebSocket client...");
      const wsClient = new WebSocket(`ws://127.0.0.1:${PIDASH_PORT}/ws/pi`);

      wsClient.on("open", () => {
        debugLog("WebSocket connected!");
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
        } catch (e: any) { console.debug("[pidash] getThinkingLevel failed:", e?.message || e); }
        const reg = JSON.stringify({
          type: "register",
          pid: process.pid,
          sessionId,
          cwd: ctx.cwd,
          branch: git.branch,
          gitDirty: git.dirty,
          gitChanges: git.changes,
          container: isContainer(),
          model: m?.name || m?.id || "",
          contextWindow: m?.contextWindow || 0,
          startedAt: new Date().toISOString(),
          sessionFile: ctx.sessionManager?.getSessionFile?.() || ctx.sessionFile || "",
          thinkingLevel: thinking,
          diffPort,
        });
        debugLog(`sending register: ${reg}`);
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
          debugLog(`open handler error (likely stale ctx): ${err}`);
        }

        // Keepalive + dead connection detection
        if (cleanupHeartbeat) cleanupHeartbeat();
        cleanupHeartbeat = setupHeartbeat({
          ws: wsClient,
          log: debugLog,
          onDead: () => {
            connected = false;
            ws = null;
            if (!shuttingDown && lastCtx) setTimeout(() => connect(lastCtx), 1000);
          },
        });

        // Show status
        try {
          if (ctx.hasUI) {
            ctx.ui.setStatus("9-pidash", ctx.ui.theme.fg("accent", `🌐 http://localhost:${PIDASH_PORT}`));
          }
        } catch {
          // ctx may be stale if session was replaced during WebSocket connect
        }
      });

      wsClient.on("message", (data: Buffer) => { handleWsMessage(data); });

      wsClient.on("close", (code: number, reason: Buffer) => {
        debugLog(`WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
        connecting = false;
        debugLog("WebSocket closed");
        connected = false;
        ws = null;
        if (!shuttingDown) {
          setTimeout(() => { if (lastCtx && !shuttingDown) connect(lastCtx); }, RECONNECT_INTERVAL_MS);
        }
      });

      wsClient.on("error", (e: Error) => {
        debugLog(`WebSocket error: ${e.message}`);
      });
    } catch (e: any) {
      debugLog(`connect error: ${e.message}`);
      connecting = false;
    }
  }

  // ── forward() helper ──────────────────────────────────────────────

  // Forward events to daemon
  function forward(type: string) {
    pi.on(type as any, (event: any, ctx: any) => {
      lastCtx = ctx;
      let payload: any = { type, ...event, timestamp: Date.now() };

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
        payload = {
          type,
          message: {
            role: m.role,
            model: m.model,
            usage: m.usage,
            provider: m.provider,
            customType: m.customType,
            display: m.display,
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
        try { ws.send(msg); } catch (e: any) { debugLog(`forward ${type} error: ${e.message}`); }
      } else if (!connected) {
        debugLog(`forward ${type}: ws not connected`);
      }
    });
  }

  // ── Setup functions ────────────────────────────────────────────────

  /** Register wrapCtx on events that provide ctx, bridging TUI dialogs to browser. */
  function setupCtxWrapping(): void {
    // Wrap ALL ctx.ui dialog methods for pidash bridging
    const wrapCtx = (_event: any, ctx: any) => {
      if (!ctx?.ui || ctx.ui.__pidashWrapped) return;
      ctx.ui.__pidashWrapped = true;
      const origSelect = ctx.ui.select.bind(ctx.ui);
      const origConfirm = ctx.ui.confirm.bind(ctx.ui);

      function raceWithBrowser<T>(
        askId: string,
        payload: object,
        origFn: (...args: any[]) => Promise<T>,
        origArgs: any[],
        extractBrowserValue: (r: any) => T,
        opts?: any,
      ): Promise<T> {
        if (ws && connected) ws.send(JSON.stringify({ id: askId, ...payload }));
        const ac = new AbortController();
        let browserResolve: ((v: T) => void) | null = null;
        const unsub = pi.events.on("pidash:ui-response", (data: unknown) => {
          const r = data as any;
          if (r.id === askId && browserResolve) { browserResolve(extractBrowserValue(r)); ac.abort(); }
        });
        return Promise.race([
          origFn(...origArgs, { ...opts, signal: opts?.signal || ac.signal }).then((v: T) => {
            browserResolve = null;
            pi.events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: askId });
            return v;
          }),
          new Promise<T>((resolve) => { browserResolve = resolve; }),
        ]).finally(() => unsub());
      }

      ctx.ui.select = async (title: string, options: string[], opts?: any) => {
        const askId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return raceWithBrowser<string | undefined>(
          askId,
          { type: "extension_ui_request", method: "select", title, options },
          origSelect, [title, options],
          (r) => r.cancelled ? undefined : r.value,
          opts,
        );
      };

      ctx.ui.confirm = async (title: string, message: string, opts?: any) => {
        const askId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return raceWithBrowser<boolean>(
          askId,
          { type: "extension_ui_request", method: "confirm", title, message },
          origConfirm, [title, message],
          (r) => r.confirmed ?? false,
          opts,
        );
      };
    };

    // Register wrapper on all events that provide ctx
    for (const evt of ["tool_call", "tool_result", "agent_start", "turn_start"] as const) {
      pi.on(evt as any, wrapCtx);
    }
  }

  /** Register all forward() calls and individual pi.on() handlers that forward events to the daemon. */
  function setupEventForwarding(): void {
    forward("agent_start");
    forward("agent_end");
    forward("agent_settled");

    // Track streaming state for prompt-queued feedback
    pi.on("agent_start", () => { isStreaming = true; });
    pi.on("agent_settled", () => { isStreaming = false; });
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
      } catch (e: any) { debugLog(`provider response forward error: ${e.message}`); }
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

    // Listen for command handler registrations from other extensions
    pi.events.on("pidash:register-command", (data: unknown) => {
      const d = data as { name: string; handler: (args: string, ctx: any) => Promise<void> };
      if (typeof d?.name === "string" && typeof d?.handler === "function") {
        if (commandHandlerRegistry.has(d.name)) {
          debugLog(`command handler overwritten: ${d.name}`);
        }
        commandHandlerRegistry.set(d.name, d.handler);
        debugLog(`registered command handler: ${d.name}`);
      }
    });

    // Request existing commands (handles load order — orchestrator may have loaded first)
    pi.events.emit("pidash:request-commands");

    // Capture command context from orchestrator for switch-session fallback
    // Only accept real ExtensionCommandContext (has switchSession method)
    pi.events.on("pidash:command-ctx", (ctx: unknown) => {
      if (ctx && typeof (ctx as any)?.switchSession === "function") {
        pidashCommandCtx = ctx as any;
      }
    });
  }

  /** Periodically send git status updates to the daemon. */
  function setupPeriodicStatus(): void {
    const statusInterval = setInterval(() => {
      if (!ws || !connected || !lastCtx) return;
      if (lastCtx.mode !== "tui") return;
      try {
        const git = getGitStatus(lastCtx.cwd);
        ws.send(JSON.stringify({
          type: "update_info",
          branch: git.branch,
          gitDirty: git.dirty,
          gitChanges: git.changes,
        }));
      } catch (e: any) { debugLog(`periodic status error: ${e?.message || e}`); }
    }, 10000);
    if (statusInterval.unref) statusInterval.unref();
  }

  /** Handle session_start event — connect or notify session switch. */
  function handleSessionStart(_event: any, ctx: any): void {
    execCtx = ctx;
    pidashCommandCtx = null;
    debugLog("execCtx created from session_start");

    // Auto-capture command context: silently run /pidash status.
    // pi.sendUserMessage won't trigger command dispatch (expandPromptTemplates: false),
    // so we call the handler directly. The context won't have switchSession yet,
    // but the /pidash handler will be called with a real ExtensionCommandContext
    // when the user types their first prompt (via before_agent_start triggering
    // the input pipeline). For now, this at least initializes the connection.
    // Session switching requires the user to have typed at least one slash command.
    if (!connected && ctx.mode === "tui") {
      connect(ctx);
    } else if (ws) {
      // Already connected — session switched (e.g., /resume, /new)
      eventBuffer.length = 0; // Clear stale events to prevent cross-session replay on reconnect
      ws.send(JSON.stringify({
        type: "session_switch",
        sessionId,
        cwd: ctx.cwd,
        branch: getCurrentBranch(ctx.cwd),
        sessionFile: ctx.sessionManager?.getSessionFile?.() || ctx.sessionFile || "",
      }));
      debugLog(`session_switch sent: cwd=${ctx.cwd}`);
    }
  }

  /** Handle input event — intercept extension commands from browser. */
  async function handleBrowserInput(event: any, _ctx: any): Promise<{ action: "handled" } | void> {
    if ((event as any).streamingBehavior && ws && connected) {
      try { ws.send(JSON.stringify({ type: "streaming-behavior", behavior: (event as any).streamingBehavior })); }
      catch (e: any) { debugLog(`streaming-behavior send error: ${e.message}`); }
    }

    // Intercept extension commands from browser
    if (event.source !== "extension") return;
    if (!event.text.startsWith("/")) return;

    const text = event.text.trim();
    const spaceIdx = text.indexOf(" ");
    const cmdName = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
    const arg = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";

    debugLog(`browser command: /${cmdName} ${arg.slice(0, 80)}`);

    const handler = commandHandlerRegistry.get(cmdName);
    if (handler) {
      try {
        await handler(arg, execCtx);
      } catch (e: any) {
        debugLog(`command /${cmdName} error: ${e.message}`);
      }
      return { action: "handled" as const };
    }
  }

  // ── Wire everything up ─────────────────────────────────────────────

  setupCtxWrapping();
  setupEventForwarding();
  setupPidashEventListeners();
  setupPeriodicStatus();

  pi.on("session_start", handleSessionStart);

  // Fallback for /reload — connect on first tool_result if not connected
  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown && ctx.mode === "tui") connect(ctx);
  });

  // Periodic reconnect — ensures sessions that started before the daemon still connect
  const cleanupReconnect = setupReconnectPoller({
    isConnected: () => connected,
    isConnecting: () => connecting,
    isShuttingDown: () => shuttingDown,
    connect: () => { if (lastCtx?.mode === "tui") connect(lastCtx); },
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

  pi.on("input", async (event, _ctx) => handleBrowserInput(event, _ctx));

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
    cleanupReconnect();
    if (cleanupHeartbeat) { cleanupHeartbeat(); cleanupHeartbeat = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
  });
}
